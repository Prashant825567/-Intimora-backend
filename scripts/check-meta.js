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

  console.log("Connected! Checking meta channel...\n");

  let total = 0;
  let textMessages = 0;
  let fileMessages = 0;
  let otherMessages = 0;

  for await (const msg of client.iterMessages(config.metaChannel, { limit: 5000 })) {
    total++;
    
    if (msg.document && msg.document.fileName && msg.document.fileName.endsWith(".json")) {
      fileMessages++;
      console.log(`📄 File: msg ${msg.id} - ${msg.document.fileName} (${msg.document.size} bytes)`);
    } else if (msg.message) {
      textMessages++;
      try {
        const data = JSON.parse(msg.message);
        if (data.t === "meta") {
          console.log(`📝 Text: msg ${msg.id} - ${data.title} (${data.id})`);
        }
      } catch {}
    } else {
      otherMessages++;
      console.log(`❓ Other: msg ${msg.id} - type: ${msg.document ? 'document' : msg.photo ? 'photo' : 'unknown'}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total messages: ${total}`);
  console.log(`Text messages: ${textMessages}`);
  console.log(`File messages: ${fileMessages}`);
  console.log(`Other: ${otherMessages}`);

  await client.disconnect();
}

main().catch(console.error);
