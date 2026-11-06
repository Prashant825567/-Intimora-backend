const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");

const config = {
  apiId: 37144075,
  apiHash: '57a11adf8679a2e7a2b6184ed7bb9c70',
  session: '1BVtsOKoBu4z3rpa0oaf6typE-B_uQjsppHZPMXxuqK7PqNgCglMysl_0IqfYcF9LVaXFvNXfGmlWYN_uO-vDzqcRjneSbfvIvMxJFzQ0SV6b0F4ZU-hCqtRujbQNLm1y9JNaHjV-_7Qg8E_HTmYy249p6HpllEplMQwQpTCkca_03e6Jx1pX79illr-U1TDX62mNB6IDBsmMyHoKDa1cEZ77Sd7g0OC5qiCpSEZ7xmpx-EIZnL9kl7ywVk1kCHg6ghnsMCI7FEr7Mvnni29lcLkfU375QGRnBSQe6SYefBo24X_-U1NEYEmbWXLV_e0galImFTRXT76AMpjgLj0CRBWmlOQxYdM=',
  metaChannel: '-1003777974779',
};

async function main() {
  const session = new StringSession(config.session);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  if (!(await client.isUserAuthorized())) {
    console.log("Not authorized!");
    return;
  }

  console.log("Connected! Converting document messages to text...\n");

  let converted = 0;
  let skipped = 0;
  let errors = 0;

  for await (const msg of client.iterMessages(config.metaChannel, { limit: 5000 })) {
    // Convert ALL document messages (regardless of filename)
    if (msg.document) {
      try {
        // Download the file content
        const bytes = await client.downloadMedia(msg);
        const jsonText = bytes.toString("utf-8");
        
        // Parse and verify it's metadata
        const data = JSON.parse(jsonText);
        if (data.t === "meta") {
          // Edit message to text
          await client.editMessage(config.metaChannel, {
            message: msg.id,
            text: JSON.stringify(data)
          });
          converted++;
          console.log(`✅ Converted: msg ${msg.id} - ${data.title} (${data.id})`);
        } else {
          skipped++;
          console.log(`⏭️  Skipped: msg ${msg.id} - not metadata (t: ${data.t})`);
        }
      } catch (e) {
        errors++;
        console.log(`❌ Error: msg ${msg.id} - ${e.message}`);
      }
    }
  }

  console.log(`\n--- Results ---`);
  console.log(`Converted: ${converted}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);
  
  await client.disconnect();
}

main().catch(console.error);
