import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";

/**
 * @typedef {Object} Env
 * @property {KVNamespace} SEPHORA_DATA_KV_STORE - The KV Namespace where the data is stored.
 */

export default {
	async scheduled(event, env, ctx) {
		// This function will be triggered by Cloudflare's cron scheduler.
		try {
		  // Execute the function to process data.
		  await handleScheduledTask(env);
		} catch (e) {
		  // Log the error.
		  console.error('Scheduled event failed:', e);
		}
	},
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === "/check-new-products") {
			try {
				const latestData = await fetchSephoraData();
				//console.log('Latest Data:', latestData); // Debugging line

				// Check if latestData is an array
				if (!Array.isArray(latestData)) {
					console.error('Latest data is not an array:');
					return new Response('Latest data format is incorrect:',latestData, { status: 500 });
				}

				let previousData = await env.SEPHORA_DATA_KV_STORE.get("previousData", { type: "json" });

				// Ensure previousData is an array
				if (!Array.isArray(previousData)) {
					previousData = [];
				}

				const newData = compareData(previousData, latestData);

                //If there is no new data lets return something that says that
				if(newData.length === 0){
					return new Response('No new products',previousData, { status: 200 });
				}
                

				// Update the stored data if there was no previous data
				//await env.SEPHORA_DATA_KV_STORE.put("previousData", JSON.stringify(latestData));

				// Fetch minimum points from query parameter, default is 0 if not specified
				const minPoints = parseInt(url.searchParams.get("minPoints") || "0", 10);
				
				
				let responseEmail = await getResponseEmail(newData, minPoints);
				if(!responseEmail){
					return new Response('No new products above',minPoints,'points', { status: 200 });
				}
				else
				{
					// Send email
					console.log('Would have sent email with products above',minPoints,'points');

					//let subject = 'New Sephora Products above '+minPoints+' points';
					//await sendEmail(responseEmail, subject, env);
				}

				// Lets return the statistics as a response to the page
				let statistics = await getStatistics(newData,previousData);
				//Lets return both statistics and the responseEmail as a response
				statistics.responseEmail = JSON.stringify(responseEmail);
				return new Response(JSON.stringify(statistics), {
					headers: { 'Content-Type': 'application/json' }
				});




				// return new Response(JSON.stringify(statistics), {
				// 	headers: { 'Content-Type': 'application/json' }
				// });


			} catch (error) {
				console.error('Error in fetching or processing data:', error);
				return new Response('Error fetching or comparing data', { status: 500 });
			}
		}
		// Lets make a path to get the latest data from the kv store without comparing or fetching
		if (url.pathname === "/fetch-current-data") {
			let previousData = await env.SEPHORA_DATA_KV_STORE.get("previousData", { type: "json" });

			// Ensure previousData is an array
			if (!Array.isArray(previousData)) {
				previousData = [];
			}
			return new Response(JSON.stringify(previousData), {
				headers: { 'Content-Type': 'application/json' }
			});
			
		}

		// Handle other paths or add a default response
		return new Response('Not found! EEEK! PANIC! TEXT ANDREW!!!', { status: 404 });
	},
};

async function handleScheduledTask(env) {
	console.log('Running scheduled task...');
	try {
		const latestData = await fetchSephoraData();
		console.log(new Date().toLocaleString(), 'Fetched ' + latestData.length + ' products');
		//console.log('Latest Data:', latestData); // Debugging line

		// Check if latestData is an array
		if (!Array.isArray(latestData)) {
			console.error('Latest data is not an array:');
			return new Response('Latest data format is incorrect:',latestData, { status: 500 });
		}

		let previousData = await env.SEPHORA_DATA_KV_STORE.get("previousData", { type: "json" });

		// Ensure previousData is an array
		if (!Array.isArray(previousData)) {
			previousData = [];
		}

		const newData = compareData(previousData, latestData);
		// Lets log the time and the number of new products
		console.log(new Date().toLocaleString(), 'New Products:', newData.length);
		//If there is no new data lets return something that says that
		if(newData.length === 0){
			return new Response('No new products',previousData, { status: 200 });
		}
		

		// Update the stored data if there was no previous data
		await env.SEPHORA_DATA_KV_STORE.put("previousData", JSON.stringify(latestData));

		

		

		let points_to_check = env.POINTS_TO_CHECK_ARRAY //Fetch from environment //[0,]//[0,600,2000]
		// Lets iterate through points to check and send an email if there are new products above the points
		for (let index = 0; index < points_to_check.length; index++) {
			const element = points_to_check[index];
			let responseEmailMinPoints = await getResponseEmail(newData, element);
			if(responseEmailMinPoints){
				// Send email
				console.log('Sending email with products above',element,'points');
				let subject = 'New Sephora Products above '+element+' points';
				await sendEmail(responseEmailMinPoints, subject, env);
			}
		}
		

		// Lets return the statistics as a response to the page
		const statistics = await getStatistics(newData,previousData);
		//Lets return it as a response
		return new Response(JSON.stringify(statistics), {
			headers: { 'Content-Type': 'application/json' }
		});


	} catch (error) {
		console.error('Error in fetching or processing data:', error);
		return new Response('Error fetching or comparing data', { status: 500 });
	}

}


	


async function sendEmail(emailHTML, subject, env) {
    const msg = createMimeMessage();

    const sender = { name: "Sephora Bot", addr: "sephorabot@andrewmohawk.xyz" };
    
    // Fetch recipients from environment variables in an array
    const recipients = env.EMAIL_RECIPIENTS.split(',');

    // Set sender and message content
    msg.setSender(sender);
    msg.addMessage({
        contentType: 'text/html',
        data: emailHTML
    });
    msg.setSubject(subject);

    // Iterate through recipients and send email
    for (const recipient of recipients) {
        msg.setRecipient(recipient);
        let message = new EmailMessage(
            sender.addr,
            recipient,
            msg.asRaw()
        );

        try {
            await env.TEST_EMAIL.send(message);
			console.log(`Email sent to ${recipient} with subject ${subject}`);
        } catch (e) {
            console.error(`Failed to send email to '${recipient}'--`, e.message);
            // Optionally, you could return false or throw an error here
        }
    }
    
    return true;
}


async function getStatistics(newData,oldData){
	
	// First lets filter
	const filteredNewData = newData.filter(product => 
		product.rewardSubType !== "Experiential_notrigger"
	);
	const filteredOldData = oldData.filter(product => 
		product.rewardSubType !== "Experiential_notrigger"
	);

	// Lets get the totals
	const totalNewData = filteredNewData.length;
	const totalOldData = filteredOldData.length;

	// Lets get the difference
	const totalDifference = totalNewData - totalOldData;
	
	//define products deleted and products added
	let productsDeleted = [];
	let productsAdded = [];
	// define categories deleted and categories added
	let categoriesDeleted = [];
	let categoriesAdded = [];

	// if the difference is above 0 lets get the categories and the products added and deleted
	if(totalDifference > 0){
		// Lets get the categories
		const categories = filteredNewData.reduce((acc, product) => {
			const category = product.biType || 'Other';
			acc[category] = acc[category] || [];
			// We just want to push the product name
			acc[category].push(product.productName);
			//acc[category].push(product);
			return acc;
		}, {});
		// Lets get the categories that have been added
		categoriesAdded = Object.keys(categories);
		// Lets get the categories that have been deleted
		categoriesDeleted = Object.keys(categories);
		// Lets get the products that have been added
		productsAdded = categoriesAdded.reduce((acc, category) => {
			acc[category] = acc[category] || [];
			acc[category].push(categories[category]);
			return acc;
		}, {});
		// Lets get the products that have been deleted
		productsDeleted = categoriesDeleted.reduce((acc, category) => {
			acc[category] = acc[category] || [];
			acc[category].push(categories[category]);
			return acc;
		}, {});
		
	}
	// Lets return the statistics with labels
	return {
		"latest_total": totalNewData,
		"stored_total": totalOldData,
		"difference": totalDifference,
		"products_added": productsAdded,
		"products_deleted": productsDeleted,
		"categories_added": categoriesAdded,
		"categories_deleted": categoriesDeleted
	}
	
	

}

async function getResponseEmail_badtimes(newData, minPoints = 0) {
    // Filter products based on description and minimum points
    const filteredData = newData.filter(product => 
        product.rewardSubType !== "Experiential_notrigger" &&
        product.rewardPoints >= minPoints
    );

    // Check if there are no products above the minimum points threshold
    if (filteredData.length === 0) {
        return false;
    }

    let html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>New Products from Sephora!</title>
			<style>
			.category-container {
			  margin-bottom: 40px;
			}
			.category-title {
			  font-size: 24px;
			  margin-bottom: 15px;
			}
			.product-grid {
			  display: grid;
			  grid-template-columns: repeat(4, 1fr); /* Four items per row */
			  gap: 10px; /* Adjust gap as needed */
			}
			.product-item {
			  display: flex;
			  flex-direction: column;
			  align-items: center;
			  text-align: center;
			  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
			  padding: 10px;
			  height: 300px; /* Fixed height for consistency */
			}
			.product-item img {
			  width: auto; /* Adjust width automatically */
			  max-height: 150px; /* Maximum image height */
			  object-fit: contain; /* Ensures image maintains aspect ratio */
			  margin-bottom: 10px;
			}
			.product-description {
			  font-size: 14px;
			}
		  </style>
		  

        </head>
        <body>
            <h1>New Products</h1>
    `;

	const productsByCategory = filteredData.reduce((acc, product) => {
        const category = product.biType || 'Other';
        acc[category] = acc[category] || [];
        acc[category].push(product);
        return acc;
    }, {});

  // Generate HTML for each category and its products
for (const [category, products] of Object.entries(productsByCategory)) {
	html += `
	  <div class="category-container">
		<h2 class="category-title">${category} Points</h2>
		<div class="product-grid">
	`;
	
	products.forEach(product => {
	  const productLink = product.fullSizeProductUrl || '#';
	  const productImage = product.image ? `https://www.sephora.com${product.image}` : '';
	  html += `
		<div class="product-item">
		  <a href="${productLink}">
			<img src="${productImage}" alt="${product.productName}">
		  </a>
		  <div class="product-description">
			<h3>${product.productName}</h3>
			<p>${product.brandName || ''}</p>
			<p>${product.rewardPoints} points</p>
		  </div>
		</div>
	  `;
	});
  
	html += `
		</div> <!-- Closing product-grid -->
	  </div> <!-- Closing category-container -->
	`;
  }

    html += `</body></html>`;
    return html;
}


async function getResponseEmail(newData, minPoints = 0) {

	// Filter products based on description and minimum points
    const filteredData = newData.filter(product => 
        product.rewardSubType !== "Experiential_notrigger" &&
        product.rewardPoints >= minPoints
    );

    // Check if there are no products above the minimum points threshold
    if (filteredData.length === 0) {
        return false;
    }

    let html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>New Products from Sephora!</title>
            <style>
  .category-container {
    margin-bottom: 20px;
  }
  .category-title {
    font-size: 24px;
    margin-bottom: 10px;
  }
  .product-grid {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-start;
    gap: 10px; /* This creates a consistent gap between the grid items */
  }
  .product-item {
    flex: 1 0 22%; /* This ensures that each item takes up roughly 22% of the container width (22% * 4 = 88%, leaving some space for margins) */
    max-width: 22%; /* This prevents the item from growing more than 22% */
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    text-align: center;
    margin-bottom: 10px; /* Add margin for spacing below items */
  }
  .product-item img {
    width: auto;
    height: auto;
    margin-bottom: 10px;
  }
</style>	
        </head>
        <body>
            <h1>New Products</h1>
    `;


    const productsByCategory = filteredData.reduce((acc, product) => {
        const category = product.biType || 'Other';
        acc[category] = acc[category] || [];
        acc[category].push(product);
        return acc;
    }, {});

    // Generate HTML for each category and its products
for (const [category, products] of Object.entries(productsByCategory)) {
	html += `
	  <div class="category-container">
		<h2 class="category-title">${category}</h2>
		<div class="product-grid">
	`;
	let productCount = 0;
	products.forEach(product => {
	  const productLink = product.fullSizeProductUrl || '#';
	  const productImage = product.image ? `https://www.sephora.com${product.image}` : '';
	  html += `
		<div class="product-item">
		  <a href="${productLink}">
			<img src="${productImage}" alt="${product.productName}">
			<h3>${product.productName}</h3>
		  </a>
		  <p>${product.brandName || ''}</p>
		  <p>Points: ${product.rewardPoints}</p>
		  <p>${product.rewardsInfo.description || ''}</p>
		</div>
	  `;
	  productCount++;
	  if(productCount >= 4){
		html += `</div><div class="product-grid">`;
		productCount = 0;
	  }
	});
  
	html += `
		</div> <!-- Closing product-grid -->
	  </div> <!-- Closing category-container -->
	`;
  }

    html += `</body></html>`;
    return html;
}


async function fetchSephoraData() {
	// Replace with the actual URL and headers for the Sephora API
	const response = await fetch('https://www.sephora.com/api/bi/rewards?source=profile', {
		method: 'GET',
		headers: {
            'Cookie': 'akamweb=E; device_type=desktop; current_country=US; rcps_product=false; adbanners=off; AKA_A2=A',
            'Sec-Ch-Ua': '"Not=A?Brand";v="99", "Chromium";v="118"',
            'Sec-Ch-Ua-Mobile': '?0',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36',
            'X-Api-Key': 'test-key',
            'Sec-Ch-Ua-Platform': '"macOS"',
            'Accept': '*/*',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            'Referer': 'https://www.sephora.com/rewards',
            'Accept-Language': 'en-US,en;q=0.9'
        }
	});
    const data = await response.json();
    return Object.values(data.biRewardGroups).flat(); // Extracting and flattening the products from biRewardGroups
}

function compareData(previousData, latestData) {
	// Implement the logic to compare previousData and latestData
	// Return an array of new products
	// This is a basic example, you might need a more complex comparison logic
	let newProducts = [];
	const previousProductIds = new Set(previousData.map(product => product.productId));

	latestData.forEach(product => {
		if (!previousProductIds.has(product.productId)) {
			newProducts.push(product);
		}
	});

	return newProducts;
}
