Deno.serve(async (request: Request) => {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/') {
    return new Response(getHTML(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  if (request.method === 'POST' && url.pathname === '/test') {
    try {
      console.log('Test endpoint hit');
      
      const text = await request.text();
      console.log('Raw body:', text);
      
      let data;
      try {
        data = JSON.parse(text);
        console.log('Parsed data:', data);
      } catch (e) {
        console.error('JSON parse error:', e);
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid JSON',
          receivedText: text.substring(0, 100)
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const { botToken, chatId, message } = data;

      if (!botToken || !chatId || !message) {
        console.error('Missing fields:', { hasBotToken: !!botToken, hasChatId: !!chatId, hasMessage: !!message });
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log('Sending to Telegram...');
      
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

      console.log('Telegram response status:', telegramResponse.status);
      
      const result = await telegramResponse.json();
      console.log('Telegram result:', result);

      if (!result.ok) {
        return new Response(JSON.stringify({
          success: false,
          error: result.description || 'Telegram API error',
          errorCode: result.error_code
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Message sent successfully!'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      console.error('Caught error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Not found', { status: 404 });
});

function getHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Test</title>
  <style>
    body { font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }
    input, textarea { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; }
    button { padding: 12px 24px; background: #007bff; color: white; border: none; cursor: pointer; }
    .result { margin-top: 20px; padding: 15px; border-radius: 5px; }
    .success { background: #d4edda; color: #155724; }
    .error { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
  <h1>Telegram Test</h1>
  <form id="form">
    <input type="text" id="botToken" placeholder="Bot Token" required>
    <input type="text" id="chatId" placeholder="Chat ID" required>
    <textarea id="message" rows="5" required>Test message</textarea>
    <button type="submit">Send</button>
  </form>
  <div id="result"></div>
  <script>
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const result = document.getElementById('result');
      result.textContent = 'Sending...';
      result.className = 'result';
      
      try {
        const response = await fetch('/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            botToken: document.getElementById('botToken').value,
            chatId: document.getElementById('chatId').value,
            message: document.getElementById('message').value
          })
        });
        
        const data = await response.json();
        
        if (data.success) {
          result.className = 'result success';
          result.textContent = '✅ ' + data.message;
        } else {
          result.className = 'result error';
          result.textContent = '❌ ' + data.error;
        }
      } catch (error) {
        result.className = 'result error';
        result.textContent = '❌ ' + error.message;
      }
    });
  </script>
</body>
</html>`;
}
