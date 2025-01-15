const WEBSOCKET_TIMEOUT = 10000; // WebSocket 超时时间（10 秒）
const API_TIMEOUT = 15000; // API 请求超时时间（15 秒）
const CACHE_TTL = 3600; // 静态资源缓存时间（1 小时）

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理 WebSocket 连接
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request, env);
    }

    // 处理 API 请求
    if (url.pathname.endsWith("/chat/completions") ||
        url.pathname.endsWith("/embeddings") ||
        url.pathname.endsWith("/models")) {
      return handleAPIRequest(request, env);
    }

    // 处理静态资源
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const cacheKey = new Request(request.url, request);
      const cache = caches.default;
      let response = await cache.match(cacheKey);

      if (!response) {
        console.log('Serving index.html from KV');
        response = new Response(await env.__STATIC_CONTENT.get('index.html'), {
          headers: {
            'content-type': 'text/html;charset=UTF-8',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
          },
        });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }

      return response;
    }

    // 处理其他静态资源
    const asset = await env.__STATIC_CONTENT.get(url.pathname.slice(1));
    if (asset) {
      const contentType = getContentType(url.pathname);
      return new Response(asset, {
        headers: {
          'content-type': contentType,
        },
      });
    }

    // 未匹配的请求
    return new Response('Not found', { status: 404 });
  },
};

async function handleWebSocket(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket connection", { status: 400 });
  }

  const url = new URL(request.url);
  const pathAndQuery = url.pathname + url.search;
  const targetUrl = `wss://generativelanguage.googleapis.com${pathAndQuery}`;

  console.log('Target URL:', targetUrl);

  const [client, proxy] = new WebSocketPair();
  proxy.accept();

  // 用于存储在连接建立前收到的消息
  let pendingMessages = [];
  const MAX_PENDING_MESSAGES = 10; // 最大缓存消息数

  const targetWebSocket = new WebSocket(targetUrl);

  console.log('Initial targetWebSocket readyState:', targetWebSocket.readyState);

  // 设置 WebSocket 超时
  const timeoutId = setTimeout(() => {
    if (pendingMessages.length === 0) {
      console.log('WebSocket connection timeout');
      targetWebSocket.close(1000, 'No activity after connection');
    }
  }, WEBSOCKET_TIMEOUT);

  targetWebSocket.addEventListener("open", () => {
    console.log('Connected to target server');
    clearTimeout(timeoutId); // 清除超时计时器

    // 连接建立后，发送所有待处理的消息
    console.log(`Processing ${pendingMessages.length} pending messages`);
    for (const message of pendingMessages) {
      try {
        targetWebSocket.send(message);
        console.log('Sent pending message:', message);
      } catch (error) {
        console.error('Error sending pending message:', error);
      }
    }
    pendingMessages = []; // 清空待处理消息队列
  });

  proxy.addEventListener("message", async (event) => {
    console.log('Received message from client:', {
      dataPreview: typeof event.data === 'string' ? event.data.slice(0, 200) : 'Binary data',
      dataType: typeof event.data,
      timestamp: new Date().toISOString()
    });

    if (targetWebSocket.readyState === WebSocket.OPEN) {
      try {
        targetWebSocket.send(event.data);
        console.log('Successfully sent message to target server');
      } catch (error) {
        console.error('Error sending to target server:', error);
      }
    } else {
      // 如果连接还未建立，将消息加入待处理队列
      if (pendingMessages.length >= MAX_PENDING_MESSAGES) {
        console.log('Too many pending messages, closing connection');
        proxy.close(1008, 'Too many pending messages');
        return;
      }
      console.log('Connection not ready, queueing message');
      pendingMessages.push(event.data);
    }
  });

  targetWebSocket.addEventListener("message", (event) => {
    console.log('Received message from target server:', {
      dataPreview: typeof event.data === 'string' ? event.data.slice(0, 200) : 'Binary data',
      dataType: typeof event.data,
      timestamp: new Date().toISOString()
    });

    try {
      if (proxy.readyState === WebSocket.OPEN) {
        proxy.send(event.data);
        console.log('Successfully forwarded message to client');
      }
    } catch (error) {
      console.error('Error forwarding to client:', error);
    }
  });

  targetWebSocket.addEventListener("close", (event) => {
    console.log('Target server connection closed:', {
      code: event.code,
      reason: event.reason || 'No reason provided',
      wasClean: event.wasClean,
      timestamp: new Date().toISOString(),
      readyState: targetWebSocket.readyState
    });
    if (proxy.readyState === WebSocket.OPEN) {
      proxy.close(event.code, event.reason);
    }
  });

  proxy.addEventListener("close", (event) => {
    console.log('Client connection closed:', {
      code: event.code,
      reason: event.reason || 'No reason provided',
      wasClean: event.wasClean,
      timestamp: new Date().toISOString()
    });
    if (targetWebSocket.readyState === WebSocket.OPEN) {
      targetWebSocket.close(event.code, event.reason);
    }
  });

  targetWebSocket.addEventListener("error", (error) => {
    console.error('Target server WebSocket error:', {
      error: error.message || 'Unknown error',
      timestamp: new Date().toISOString(),
      readyState: targetWebSocket.readyState
    });
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

async function handleAPIRequest(request, env) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('API request timeout')), API_TIMEOUT);
  });

  try {
    const worker = await import('./api_proxy/worker.mjs');
    const responsePromise = worker.default.fetch(request);
    return await Promise.race([responsePromise, timeoutPromise]);
  } catch (error) {
    console.error('API request error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStatus = error.status || 500;
    return new Response(errorMessage, {
      status: errorStatus,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
      }
    });
  }
}

function getContentType(path) {
  const ext = path.split('.').pop().toLowerCase();
  const types = {
    'js': 'application/javascript',
    'css': 'text/css',
    'html': 'text/html',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif'
  };
  return types[ext] || 'text/plain';
}
