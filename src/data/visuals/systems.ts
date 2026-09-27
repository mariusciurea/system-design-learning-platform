import type { VisualSpec } from '@/components/architecture/FlowVisual';

/** Networking, async, reliability, distributed, architecture, security, observability. */
export const systemVisuals: Record<string, VisualSpec> = {
  // ---- Networking ---------------------------------------------------------
  dns: {
    width: 760,
    height: 330,
    caption: 'Every level caches the answer for its TTL, so a change is never instant.',
    nodes: [
      { id: 'browser', kind: 'client', label: 'Browser', sub: 'then the OS cache', x: 29, y: 110, w: 152, h: 80 },
      { id: 'resolver', kind: 'dns', label: 'Resolver', sub: 'recursive, caches', x: 250, y: 110, w: 170, h: 80 },
      { id: 'root', kind: 'dns', label: 'Root server', sub: 'refers to .com', x: 520, y: 10, w: 190, h: 74 },
      { id: 'tld', kind: 'dns', label: '.com TLD server', sub: 'refers to example.com', x: 520, y: 105, w: 190, h: 74 },
      { id: 'auth', kind: 'dns', label: 'Authoritative', sub: 'A record, TTL 300 s', x: 520, y: 200, w: 190, h: 78 },
      { id: 'web', kind: 'server', label: 'Web server', sub: '203.0.113.10', x: 30, y: 240, w: 170, h: 76 },
    ],
    edges: [
      { from: 'browser', to: 'resolver', tone: 'brand', rate: 2 },
      { from: 'resolver', to: 'root', tone: 'violet', rate: 0.4 },
      { from: 'resolver', to: 'tld', tone: 'violet', rate: 0.8 },
      { from: 'resolver', to: 'auth', tone: 'violet', rate: 1 },
      { from: 'browser', to: 'web', tone: 'ok', rate: 1.6 },
    ],
    steps: [
      { from: 'browser', to: 'resolver', label: 'Local caches miss: ask resolver' },
      { from: 'resolver', to: 'root', label: 'Root: ask the .com servers' },
      { from: 'resolver', to: 'tld', label: '.com: ask example.com nameservers' },
      { from: 'resolver', to: 'auth', label: 'Ask the authoritative server' },
      { from: 'auth', to: 'resolver', label: 'A record returned, TTL 300 s' },
      { from: 'resolver', to: 'browser', label: 'Resolver caches it, answers browser' },
      { from: 'browser', to: 'web', label: 'Browser connects to that IP' },
      { from: 'resolver', to: 'browser', label: 'Within TTL: answered from cache', outcome: 'cache-hit' },
    ],
  },

  cdn: {
    width: 760,
    height: 332,
    caption: 'Most users are served from an edge a few milliseconds away. Only misses reach the origin.',
    nodes: [
      { id: 'origin', kind: 'server', label: 'Origin', sub: 'us-east', x: 305, y: 12, w: 150, h: 80 },
      { id: 'eu', kind: 'cdn', label: 'Europe edge', x: 40, y: 130, w: 160, h: 90, stat: ['RTT', '11 ms'] },
      { id: 'us', kind: 'cdn', label: 'US edge', x: 300, y: 130, w: 160, h: 90, stat: ['RTT', '10 ms'] },
      { id: 'ap', kind: 'cdn', label: 'Asia edge', x: 560, y: 130, w: 160, h: 90, stat: ['RTT', '13 ms'] },
      { id: 'users', kind: 'client', label: 'Users worldwide', x: 290, y: 250, w: 180, h: 69 },
    ],
    edges: [
      { from: 'users', to: 'eu', tone: 'ok', rate: 2 },
      { from: 'users', to: 'us', tone: 'ok', rate: 2.2 },
      { from: 'users', to: 'ap', tone: 'ok', rate: 1.8 },
      { from: 'eu', to: 'origin', tone: 'muted', dashed: true, rate: 0.3, label: 'on miss' },
      { from: 'us', to: 'origin', tone: 'muted', dashed: true, rate: 0.3 },
      { from: 'ap', to: 'origin', tone: 'muted', dashed: true, rate: 0.3 },
    ],
    steps: [
      { from: 'users', to: 'eu', label: 'Paris user routed to nearest edge' },
      { from: 'eu', to: 'origin', label: 'Miss: edge fetches from origin', outcome: 'warning' },
      { from: 'origin', to: 'eu', label: 'Copy stored at the edge' },
      { from: 'users', to: 'eu', label: 'Next Paris user: 11 ms hit', outcome: 'cache-hit' },
      { from: 'users', to: 'us', label: 'US users hit the US edge', outcome: 'cache-hit' },
      { from: 'users', to: 'ap', label: 'Asia: 13 ms, not 240 ms', outcome: 'cache-hit' },
    ],
  },

  'cdn-caching': {
    width: 760,
    height: 280,
    caption: 'Cache key plus TTL decide the hit rate - not the vendor.',
    nodes: [
      { id: 'user', kind: 'client', label: 'GET /app.a91f.js', x: 40, y: 100, w: 180, h: 74 },
      { id: 'edge', kind: 'cdn', label: 'Edge cache', sub: 'max-age 1 year', x: 300, y: 95, w: 170, h: 96, stat: ['Hit rate', '98%'] },
      { id: 'origin', kind: 'server', label: 'Origin', x: 570, y: 100, w: 150, h: 74 },
    ],
    edges: [
      { from: 'user', to: 'edge', tone: 'brand', rate: 4 },
      { from: 'edge', to: 'origin', tone: 'muted', dashed: true, rate: 0.2, label: 'rarely' },
    ],
    steps: [
      { from: 'user', to: 'edge', label: 'Cache key: host plus path' },
      { from: 'edge', to: 'origin', label: 'First request misses, fetch once', outcome: 'warning' },
      { from: 'origin', to: 'edge', label: 'Stored for a year, immutable' },
      { from: 'user', to: 'edge', label: 'Every later request hits', outcome: 'cache-hit' },
      { from: 'user', to: 'edge', label: 'New build, new URL, no purge' },
    ],
  },

  'api-gateway': {
    width: 760,
    height: 330,
    caption: 'Auth and limits are applied once, before anything reaches a service.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', x: 40, y: 125, w: 140, h: 74 },
      { id: 'gw', kind: 'api-gateway', label: 'API Gateway x2', sub: 'JWT - limits - routing', x: 270, y: 110, w: 190, h: 96 },
      { id: 'users', kind: 'service', label: 'Users', x: 570, y: 20, w: 150, h: 74 },
      { id: 'orders', kind: 'service', label: 'Orders', x: 570, y: 125, w: 150, h: 74 },
      { id: 'pay', kind: 'service', label: 'Payments', x: 570, y: 230, w: 150, h: 74 },
    ],
    edges: [
      { from: 'client', to: 'gw', tone: 'brand', rate: 4 },
      { from: 'gw', to: 'users', tone: 'ok', rate: 1.2 },
      { from: 'gw', to: 'orders', tone: 'ok', rate: 2 },
      { from: 'gw', to: 'pay', tone: 'ok', rate: 1 },
    ],
    steps: [
      { from: 'client', to: 'gw', label: 'GET /api/orders/123' },
      { from: 'gw', to: 'orders', label: 'Token valid, routed to Orders' },
      { from: 'gw', to: 'users', label: '/api/users/* goes to Users' },
      { from: 'gw', to: 'pay', label: '/api/payments/* goes to Payments' },
      { from: 'client', to: 'gw', label: 'Bad token: 401 at the gateway', outcome: 'failure' },
      { from: 'client', to: 'gw', label: 'Over quota: 429, no service called', outcome: 'warning' },
    ],
  },

  'reverse-proxy': {
    width: 760,
    height: 300,
    caption: 'One front door: TLS, routing and caching before your code runs.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', x: 40, y: 110, w: 140, h: 74 },
      { id: 'proxy', kind: 'api-gateway', label: 'Reverse proxy x2', sub: 'TLS ends here', x: 260, y: 105, w: 180, h: 84 },
      { id: 'api', kind: 'server', label: '/api', x: 560, y: 20, w: 160, h: 74 },
      { id: 'static', kind: 'storage', label: '/static', x: 560, y: 115, w: 160, h: 74 },
      { id: 'ws', kind: 'service', label: '/ws', x: 560, y: 210, w: 160, h: 74 },
    ],
    edges: [
      { from: 'client', to: 'proxy', tone: 'brand', rate: 4 },
      { from: 'proxy', to: 'api', tone: 'ok', rate: 2 },
      { from: 'proxy', to: 'static', tone: 'ok', rate: 1.6 },
      { from: 'proxy', to: 'ws', tone: 'ok', rate: 0.8 },
    ],
    steps: [
      { from: 'client', to: 'proxy', label: 'TLS ends at the proxy' },
      { from: 'proxy', to: 'api', label: '/api/* routed to app servers' },
      { from: 'proxy', to: 'static', label: '/static/* served from storage' },
      { from: 'proxy', to: 'ws', label: '/ws upgraded to WebSocket service' },
      { from: 'proxy', to: 'client', label: 'Client never sees backend addresses' },
      { from: 'proxy', to: 'client', label: 'Repeat page answered from proxy cache', outcome: 'cache-hit' },
    ],
  },

  'forward-proxy': {
    width: 760,
    height: 260,
    caption: 'A forward proxy represents the client; a reverse proxy represents the server.',
    nodes: [
      { id: 'c1', kind: 'client', label: 'Employee laptop', x: 40, y: 30, w: 170, h: 74 },
      { id: 'c2', kind: 'client', label: 'CI runner', x: 40, y: 140, w: 170, h: 74 },
      { id: 'proxy', kind: 'api-gateway', label: 'Forward proxy x2', sub: 'policy + audit', x: 300, y: 85, w: 180, h: 84 },
      { id: 'net', kind: 'cdn', label: 'Internet', x: 580, y: 85, w: 150, h: 78 },
    ],
    edges: [
      { from: 'c1', to: 'proxy', tone: 'brand', rate: 2 },
      { from: 'c2', to: 'proxy', tone: 'brand', rate: 1.6 },
      { from: 'proxy', to: 'net', tone: 'ok', rate: 2.6 },
    ],
    steps: [
      { from: 'c1', to: 'proxy', label: 'Laptop sends via the proxy' },
      { from: 'proxy', to: 'net', label: 'Allowed, sent from the proxy IP' },
      { from: 'net', to: 'proxy', label: 'Response logged for the audit' },
      { from: 'proxy', to: 'c1', label: 'Site saw the proxy, not laptop' },
      { from: 'c2', to: 'proxy', label: 'Blocked domain denied at proxy', outcome: 'failure' },
    ],
  },

  'http-https': {
    width: 760,
    height: 260,
    caption: 'Methods and headers tell every cache what it may do. HTTPS decides who can read them.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Browser', sub: 'GET /products/42', x: 20, y: 90, w: 150, h: 80 },
      { id: 'path', kind: 'service', label: 'Network path', sub: 'Wi-Fi, ISP routers', x: 210, y: 90, w: 150, h: 80 },
      { id: 'cache', kind: 'cdn', label: 'CDN cache', sub: 'max-age 300', x: 400, y: 88, w: 150, h: 84 },
      { id: 'server', kind: 'server', label: 'Origin', sub: 'ETag "a91f"', x: 590, y: 90, w: 150, h: 80 },
    ],
    edges: [
      { from: 'client', to: 'path', tone: 'brand', rate: 3 },
      { from: 'path', to: 'cache', tone: 'brand', rate: 3 },
      { from: 'cache', to: 'server', tone: 'violet', rate: 0.8 },
    ],
    steps: [
      { from: 'client', to: 'path', label: 'HTTP: every router can read it', outcome: 'warning' },
      { from: 'client', to: 'path', label: 'HTTPS: routers see only ciphertext' },
      { from: 'path', to: 'cache', label: 'GET is safe to cache' },
      { from: 'cache', to: 'server', label: 'Miss: forwarded to the origin' },
      { from: 'server', to: 'cache', label: '200 OK, ETag, max-age 300' },
      { from: 'cache', to: 'path', label: 'Within 300 s: served from cache', outcome: 'cache-hit' },
      { from: 'cache', to: 'server', label: 'Expired: revalidate with If-None-Match' },
      { from: 'server', to: 'cache', label: '304 Not Modified, no body', outcome: 'cache-hit' },
    ],
  },

  'tcp-vs-udp': {
    width: 760,
    height: 280,
    caption: 'TCP resends and delivers in order. UDP just keeps sending.',
    // The two middle boxes are the same network, drawn once per transport so each
    // protocol keeps its own lane; the Network icon says they are the path, not a server.
    nodes: [
      { id: 'send', kind: 'client', label: 'Sender', x: 40, y: 100, w: 150, h: 76 },
      { id: 'tcp', kind: 'cdn', label: 'Over TCP', sub: 'ordered, resent', x: 300, y: 25, w: 170, h: 80 },
      { id: 'udp', kind: 'cdn', label: 'Over UDP', sub: 'no guarantees', x: 300, y: 175, w: 170, h: 80 },
      { id: 'recv', kind: 'server', label: 'Receiver', x: 570, y: 100, w: 150, h: 76 },
    ],
    edges: [
      { from: 'send', to: 'tcp', tone: 'ok', rate: 2 },
      { from: 'tcp', to: 'recv', tone: 'ok', rate: 2 },
      { from: 'send', to: 'udp', tone: 'warn', rate: 3.4 },
      { from: 'udp', to: 'recv', tone: 'warn', rate: 2.8, outcome: 'warning' },
    ],
    steps: [
      { from: 'send', to: 'tcp', label: 'TCP: handshake first, one round trip' },
      { from: 'tcp', to: 'recv', label: 'Numbered bytes arrive in order' },
      { from: 'recv', to: 'tcp', label: 'Receiver ACKs what arrived' },
      { from: 'tcp', to: 'recv', label: 'Lost packet resent: late, not missing', outcome: 'warning' },
      { from: 'send', to: 'udp', label: 'UDP: no handshake, just send' },
      { from: 'udp', to: 'recv', label: 'Lost datagram stays lost', outcome: 'failure' },
      { from: 'udp', to: 'recv', label: 'Next datagram still arrives on time' },
    ],
  },

  'what-happens-when-you-type-a-url': {
    width: 760,
    height: 320,
    caption: 'DNS, TCP and TLS all happen before your server does any work.',
    nodes: [
      { id: 'browser', kind: 'client', label: 'Browser', sub: 'https://example.com', x: 25, y: 30, w: 165, h: 80 },
      // example.com points at the CDN, so the address the resolver hands back is an edge.
      { id: 'dns', kind: 'dns', label: 'DNS resolver', sub: 'name to CDN edge IP', x: 280, y: 30, w: 190, h: 80 },
      { id: 'edge', kind: 'cdn', label: 'CDN edge', sub: 'ends TLS nearby', x: 30, y: 170, w: 150, h: 80 },
      { id: 'lb', kind: 'load-balancer', label: 'Load Balancer', x: 250, y: 170, w: 160, h: 80 },
      { id: 'api', kind: 'server', label: 'App server', x: 460, y: 170, w: 130, h: 80 },
      { id: 'cache', kind: 'cache', label: 'Cache', x: 620, y: 110, w: 120, h: 74 },
      { id: 'db', kind: 'sql', label: 'Database', x: 620, y: 230, w: 120, h: 74 },
    ],
    edges: [
      // The address is cached for its TTL, so a lookup is far rarer than a request.
      { from: 'browser', to: 'dns', tone: 'violet', rate: 0.25 },
      // More goes in than is forwarded: static files are answered at the edge.
      { from: 'browser', to: 'edge', tone: 'brand', rate: 1.6 },
      { from: 'edge', to: 'lb', tone: 'brand', rate: 1 },
      { from: 'lb', to: 'api', tone: 'ok', rate: 1 },
      // The app server asks the cache, and only on a miss the database; the
      // response goes back from the app server, not from the cache.
      { from: 'api', to: 'cache', tone: 'ok', rate: 1, outcome: 'cache-hit' },
      { from: 'api', to: 'db', tone: 'muted', rate: 0.4, dashed: true },
    ],
    // The same order as the Lab. The resolver already has the address, as on the
    // Lab focus of this Concept, so its answer is a cache hit - the address of a
    // CDN edge, which is why the handshakes that follow go to the edge. A miss is a plain
    // dot, as in the Lab, where the triangle means plain HTTP readable on the
    // path. Static files come last: the browser only finds them once the HTML
    // has arrived and been parsed.
    steps: [
      { from: 'browser', to: 'dns', label: 'Resolve example.com to an IP' },
      { from: 'dns', to: 'browser', label: 'Cached answer: the CDN edge IP', outcome: 'cache-hit' },
      { from: 'browser', to: 'edge', label: 'TCP and TLS handshakes at edge' },
      { from: 'browser', to: 'edge', label: 'GET /products/42 sent to edge' },
      { from: 'edge', to: 'lb', label: 'Page request forwarded to origin' },
      { from: 'lb', to: 'api', label: 'Load balancer picks a server' },
      { from: 'api', to: 'cache', label: 'Cache miss for this page' },
      { from: 'api', to: 'db', label: 'Query the database, fill cache' },
      { from: 'api', to: 'lb', label: 'Response goes back the same way' },
      { from: 'lb', to: 'edge', label: 'Back through the CDN edge' },
      { from: 'edge', to: 'browser', label: 'HTML arrives at the browser' },
      { from: 'browser', to: 'browser', label: 'Browser parses, lays out, paints' },
      { from: 'browser', to: 'edge', label: 'Then asks for images and scripts' },
      { from: 'edge', to: 'browser', label: 'Static files served from edge', outcome: 'cache-hit' },
    ],
  },

  // ---- Async --------------------------------------------------------------
  'message-queues': {
    width: 760,
    height: 320,
    caption: '100 msg/sec in, 60 msg/sec out. The queue absorbs a burst, not a permanent deficit.',
    nodes: [
      { id: 'producer', kind: 'server', label: 'Producer', sub: '100 msg/sec', x: 40, y: 115, w: 160, h: 80 },
      { id: 'queue', kind: 'queue', label: 'Queue', sub: 'depth 240 and growing', x: 280, y: 105, w: 190, h: 96, stat: ['Wait', '4 s'], alert: true },
      { id: 'w1', kind: 'worker', label: 'Worker 1', x: 560, y: 15, w: 160, h: 90, stat: ['Rate', '20/s'] },
      { id: 'w2', kind: 'worker', label: 'Worker 2', x: 560, y: 115, w: 160, h: 90, stat: ['Rate', '20/s'] },
      { id: 'w3', kind: 'worker', label: 'Worker 3', x: 560, y: 215, w: 160, h: 90, stat: ['Rate', '20/s'] },
    ],
    edges: [
      { from: 'producer', to: 'queue', tone: 'brand', rate: 5 },
      { from: 'queue', to: 'w1', tone: 'ok', rate: 1 },
      { from: 'queue', to: 'w2', tone: 'ok', rate: 1 },
      { from: 'queue', to: 'w3', tone: 'ok', rate: 1 },
    ],
    steps: [
      { from: 'producer', to: 'queue', label: 'Enqueue, return at once' },
      { from: 'queue', to: 'w1', label: 'Worker pulls, processes, acks' },
      { from: 'queue', to: 'w2', label: 'Next message, next free worker' },
      { from: 'queue', to: 'w3', label: 'Three workers drain 60 per second' },
      { from: 'producer', to: 'queue', label: '100 in: depth grows 40/s', outcome: 'warning' },
    ],
  },

  kafka: {
    width: 760,
    height: 310,
    caption: 'Ordered per partition, replayable, and read independently by each consumer group.',
    nodes: [
      { id: 'prod', kind: 'server', label: 'Producer', x: 40, y: 110, w: 150, h: 78 },
      { id: 'p0', kind: 'queue', label: 'Partition 0', x: 270, y: 20, w: 170, h: 74 },
      { id: 'p1', kind: 'queue', label: 'Partition 1', x: 270, y: 110, w: 170, h: 74 },
      { id: 'p2', kind: 'queue', label: 'Partition 2', x: 270, y: 200, w: 170, h: 74 },
      { id: 'ga', kind: 'worker', label: 'Group A', sub: 'P0 at offset 8,412', x: 540, y: 55, w: 180, h: 80 },
      { id: 'gb', kind: 'worker', label: 'Group B', sub: 'P0 at offset 120', x: 540, y: 175, w: 180, h: 80 },
    ],
    edges: [
      { from: 'prod', to: 'p0', tone: 'brand', rate: 1.4 },
      { from: 'prod', to: 'p1', tone: 'brand', rate: 1.4 },
      { from: 'prod', to: 'p2', tone: 'brand', rate: 1.4 },
      { from: 'p0', to: 'ga', tone: 'ok', rate: 1.2 },
      { from: 'p1', to: 'ga', tone: 'ok', rate: 1.2 },
      { from: 'p2', to: 'ga', tone: 'ok', rate: 1.2 },
      { from: 'p0', to: 'gb', tone: 'violet', rate: 0.8 },
      { from: 'p1', to: 'gb', tone: 'violet', rate: 0.8 },
      { from: 'p2', to: 'gb', tone: 'violet', rate: 0.8 },
    ],
    steps: [
      { from: 'prod', to: 'p0', label: 'Key hash picks the partition' },
      { from: 'prod', to: 'p1', label: 'Different key, different partition' },
      { from: 'p0', to: 'ga', label: 'Group A reads at its offset' },
      { from: 'p0', to: 'gb', label: 'Group B reads the same record' },
      { from: 'p2', to: 'gb', label: 'Rewind the offset to replay' },
    ],
  },

  'pub-sub': {
    width: 760,
    height: 300,
    caption: 'One event, every subscriber gets its own copy and its own backlog.',
    nodes: [
      { id: 'pub', kind: 'server', label: 'Publisher', sub: 'user.signed_up', x: 40, y: 110, w: 170, h: 80 },
      { id: 'topic', kind: 'queue', label: 'Topic', x: 300, y: 110, w: 150, h: 80 },
      { id: 's1', kind: 'worker', label: 'Welcome email', x: 550, y: 15, w: 180, h: 74 },
      { id: 's2', kind: 'worker', label: 'CRM sync', x: 550, y: 110, w: 180, h: 74 },
      { id: 's3', kind: 'worker', label: 'Analytics', x: 550, y: 205, w: 180, h: 74 },
    ],
    edges: [
      { from: 'pub', to: 'topic', tone: 'brand', rate: 2 },
      { from: 'topic', to: 's1', tone: 'ok', rate: 2 },
      { from: 'topic', to: 's2', tone: 'ok', rate: 2 },
      { from: 'topic', to: 's3', tone: 'ok', rate: 2 },
    ],
    steps: [
      { from: 'pub', to: 'topic', label: 'Publish user.signed_up once' },
      { from: 'topic', to: 's1', label: 'Welcome email gets a copy' },
      { from: 'topic', to: 's2', label: 'CRM sync gets its own copy' },
      { from: 'topic', to: 's3', label: 'Analytics too, at its pace' },
    ],
  },

  'event-driven-architecture': {
    width: 760,
    height: 310,
    caption: 'The publisher does not know who reacts. Adding a consumer changes nothing upstream.',
    nodes: [
      { id: 'order', kind: 'service', label: 'Order Service', sub: 'OrderPlaced', x: 40, y: 110, w: 180, h: 84 },
      { id: 'bus', kind: 'queue', label: 'Event bus', x: 310, y: 110, w: 150, h: 84 },
      { id: 'pay', kind: 'service', label: 'Payments', x: 550, y: 10, w: 170, h: 74 },
      { id: 'inv', kind: 'service', label: 'Inventory', x: 550, y: 105, w: 170, h: 74 },
      { id: 'notif', kind: 'service', label: 'Notifications', x: 550, y: 200, w: 170, h: 74 },
    ],
    edges: [
      { from: 'order', to: 'bus', tone: 'brand', rate: 2 },
      { from: 'bus', to: 'pay', tone: 'ok', rate: 2 },
      { from: 'bus', to: 'inv', tone: 'ok', rate: 2 },
      { from: 'bus', to: 'notif', tone: 'ok', rate: 2 },
    ],
    steps: [
      { from: 'order', to: 'bus', label: 'OrderPlaced: no idea who listens' },
      { from: 'bus', to: 'pay', label: 'Payments captures the charge' },
      { from: 'bus', to: 'inv', label: 'Inventory reserves the stock' },
      { from: 'bus', to: 'notif', label: 'Notifications emails the customer' },
    ],
  },

  'background-workers': {
    width: 820,
    height: 290,
    caption: 'The API answers in milliseconds; the slow work happens after the response.',
    nodes: [
      { id: 'user', kind: 'client', label: 'POST /export', x: 40, y: 100, w: 160, h: 76 },
      { id: 'api', kind: 'server', label: 'API', sub: '202 Accepted', x: 270, y: 100, w: 150, h: 80 },
      { id: 'queue', kind: 'queue', label: 'Job queue', x: 480, y: 25, w: 150, h: 74 },
      { id: 'worker', kind: 'worker', label: 'Workers x4', x: 480, y: 175, w: 150, h: 78 },
      { id: 'store', kind: 'storage', label: 'Object storage', x: 655, y: 175, w: 150, h: 78 },
    ],
    edges: [
      { from: 'user', to: 'api', tone: 'brand', rate: 2.6 },
      { from: 'api', to: 'queue', tone: 'warn', rate: 2 },
      { from: 'queue', to: 'worker', tone: 'ok', rate: 1.8 },
      { from: 'worker', to: 'store', tone: 'info', rate: 1.2 },
    ],
    steps: [
      { from: 'user', to: 'api', label: 'User asks for an export' },
      { from: 'api', to: 'queue', label: 'Enqueue the job id' },
      { from: 'api', to: 'user', label: '202 Accepted in milliseconds' },
      { from: 'queue', to: 'worker', label: 'A free worker pulls it' },
      { from: 'worker', to: 'store', label: 'Slow render, file saved' },
    ],
  },

  'task-queues': {
    width: 760,
    height: 290,
    caption: 'Separate queues per priority, so a bulk import cannot delay a password reset.',
    nodes: [
      { id: 'app', kind: 'server', label: 'Application', x: 40, y: 105, w: 160, h: 80 },
      { id: 'high', kind: 'queue', label: 'transactional', sub: 'high priority', x: 290, y: 25, w: 180, h: 80 },
      { id: 'bulk', kind: 'queue', label: 'bulk', sub: 'low priority', x: 290, y: 175, w: 180, h: 80 },
      { id: 'w1', kind: 'worker', label: 'Fast workers', x: 560, y: 25, w: 160, h: 78 },
      { id: 'w2', kind: 'worker', label: 'Bulk workers', x: 560, y: 175, w: 160, h: 78 },
    ],
    edges: [
      { from: 'app', to: 'high', tone: 'ok', rate: 1.6 },
      { from: 'app', to: 'bulk', tone: 'warn', rate: 3 },
      { from: 'high', to: 'w1', tone: 'ok', rate: 1.6 },
      { from: 'bulk', to: 'w2', tone: 'warn', rate: 1.4 },
    ],
    steps: [
      { from: 'app', to: 'bulk', label: 'Import enqueues 50,000 jobs' },
      { from: 'bulk', to: 'w2', label: 'Bulk workers chew the backlog', outcome: 'warning' },
      { from: 'app', to: 'high', label: 'Password reset: its own queue' },
      { from: 'high', to: 'w1', label: 'Sent in seconds, not after import' },
    ],
  },

  'rabbitmq-concepts': {
    width: 760,
    height: 290,
    caption: 'The broker routes: publishers pick a routing key, bindings decide the queues.',
    nodes: [
      { id: 'pub', kind: 'server', label: 'publish', sub: 'order.created', x: 40, y: 105, w: 170, h: 80 },
      { id: 'ex', kind: 'api-gateway', label: 'Topic exchange', x: 280, y: 105, w: 180, h: 80 },
      { id: 'q1', kind: 'queue', label: 'orders queue', x: 540, y: 25, w: 180, h: 74 },
      { id: 'q2', kind: 'queue', label: 'audit queue', x: 540, y: 175, w: 180, h: 74 },
    ],
    edges: [
      { from: 'pub', to: 'ex', tone: 'brand', rate: 2.4 },
      { from: 'ex', to: 'q1', tone: 'ok', rate: 2.4, label: 'order.*' },
      { from: 'ex', to: 'q2', tone: 'ok', rate: 2.4, label: '*.created' },
    ],
    steps: [
      { from: 'pub', to: 'ex', label: 'Publish with key order.created' },
      { from: 'ex', to: 'q1', label: 'Matches order.*, copy queued' },
      { from: 'ex', to: 'q2', label: 'Also matches *.created, copy queued' },
      { from: 'pub', to: 'ex', label: 'user.updated matches nothing: dropped', outcome: 'failure' },
    ],
  },

  // ---- Reliability --------------------------------------------------------
  'circuit-breaker': {
    width: 760,
    height: 310,
    caption: 'Open circuit: calls fail in a millisecond or two instead of waiting 30 seconds for a timeout.',
    nodes: [
      { id: 'api', kind: 'server', label: 'API Service', sub: 'the caller', x: 40, y: 115, w: 160, h: 80 },
      { id: 'cb', kind: 'api-gateway', label: 'Circuit breaker', sub: 'OPEN, in the caller', x: 280, y: 105, w: 180, h: 96, stat: ['Failures', '11/20'], alert: true },
      { id: 'pay', kind: 'service', label: 'Payment Service', sub: 'timing out', x: 550, y: 20, w: 180, h: 82, status: 'down' },
      { id: 'fallback', kind: 'cache', label: 'Fallback', sub: 'cached response', x: 550, y: 195, w: 180, h: 82 },
    ],
    edges: [
      { from: 'api', to: 'cb', tone: 'brand', rate: 3.4 },
      { from: 'cb', to: 'pay', tone: 'muted', dashed: true, label: 'blocked' },
      { from: 'cb', to: 'fallback', tone: 'warn', rate: 3, outcome: 'warning' },
    ],
    steps: [
      { from: 'api', to: 'cb', label: 'Every call goes through the breaker' },
      { from: 'cb', to: 'pay', label: 'Timeouts and 5xx fill the window', outcome: 'failure' },
      { from: 'cb', to: 'fallback', label: 'Threshold crossed: open, fail fast', outcome: 'warning' },
      { from: 'cb', to: 'pay', label: 'Cooldown over: a few trial calls' },
      { from: 'pay', to: 'cb', label: 'Trials succeed, circuit closes' },
    ],
  },

  retry: {
    width: 760,
    height: 280,
    caption: 'Retry transient errors only, with a cap and backoff - and send an idempotency key so a retried write happens once.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', sub: 'max 3 attempts', x: 40, y: 100, w: 160, h: 80 },
      { id: 'svc', kind: 'service', label: 'Order Service', sub: 'brief 503s', x: 290, y: 95, w: 190, h: 90, status: 'degraded' },
      { id: 'db', kind: 'sql', label: 'Orders DB', sub: 'idempotency keys', x: 570, y: 95, w: 160, h: 90 },
    ],
    edges: [
      { from: 'client', to: 'svc', tone: 'warn', rate: 1.6, outcome: 'warning' },
      { from: 'svc', to: 'db', tone: 'ok', rate: 1.2 },
    ],
    steps: [
      { from: 'client', to: 'svc', label: 'Attempt 1 returns 503, retryable', outcome: 'failure' },
      { from: 'client', to: 'svc', label: 'Backoff, then attempt 2 times out', outcome: 'warning' },
      { from: 'svc', to: 'db', label: 'Order saved, but response lost' },
      { from: 'client', to: 'svc', label: 'Attempt 3, same idempotency key', outcome: 'warning' },
      { from: 'svc', to: 'db', label: 'Key found: no second order', outcome: 'cache-hit' },
      { from: 'svc', to: 'client', label: 'Stored 201 replayed to client' },
    ],
  },

  'exponential-backoff': {
    width: 760,
    height: 300,
    caption: 'Full jitter: each client draws its wait between 0 and the backoff, so a synchronised wave becomes a trickle.',
    nodes: [
      { id: 'g1', kind: 'client', label: 'Client group 1', sub: 'drew ~0.2 s', x: 40, y: 15, w: 180, h: 80 },
      { id: 'g2', kind: 'client', label: 'Client group 2', sub: 'drew ~0.6 s', x: 40, y: 110, w: 180, h: 80 },
      { id: 'g3', kind: 'client', label: 'Client group 3', sub: 'drew ~0.9 s', x: 40, y: 205, w: 180, h: 80 },
      { id: 'svc', kind: 'server', label: 'WebSocket server', sub: 'restarting', x: 500, y: 100, w: 210, h: 100, stat: ['Retry load', 'spread out'] },
    ],
    edges: [
      { from: 'g1', to: 'svc', tone: 'warn', rate: 0.9, outcome: 'warning' },
      { from: 'g2', to: 'svc', tone: 'warn', rate: 0.9, outcome: 'warning' },
      { from: 'g3', to: 'svc', tone: 'warn', rate: 0.9, outcome: 'warning' },
    ],
    steps: [
      { from: 'svc', to: 'g1', label: 'Restart drops every connection', outcome: 'failure' },
      { from: 'g1', to: 'svc', label: 'Group 1 drew 0.2 s', outcome: 'warning' },
      { from: 'g2', to: 'svc', label: 'Group 2 drew 0.6 s', outcome: 'warning' },
      { from: 'g3', to: 'svc', label: 'Group 3 drew 0.9 s', outcome: 'warning' },
      { from: 'svc', to: 'g1', label: 'Spread out, so it accepts them' },
      { from: 'g2', to: 'svc', label: 'Rejected? Next draw from 0-2 s', outcome: 'warning' },
    ],
  },

  'health-checks': {
    asymmetric: 'api-2 failed its probes and was ejected from the pool, which is the point.',
    width: 760,
    height: 294,
    caption: 'Three failed probes in a row eject an instance; two passes put it back.',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', sub: '500 req/sec', x: 20, y: 105, w: 140, h: 80 },
      { id: 'lb', kind: 'load-balancer', label: 'Load Balancer', sub: 'probes every 2 s', x: 230, y: 100, w: 180, h: 90 },
      { id: 'h1', kind: 'server', label: 'api-1', sub: '200 OK', x: 560, y: 10, w: 160, h: 80 },
      { id: 'h2', kind: 'server', label: 'api-2', sub: '3 failed probes', x: 560, y: 105, w: 160, h: 80, status: 'down' },
      { id: 'h3', kind: 'server', label: 'api-3', sub: '200 OK', x: 560, y: 200, w: 160, h: 80 },
    ],
    edges: [
      { from: 'users', to: 'lb', tone: 'brand', rate: 3 },
      { from: 'lb', to: 'h1', tone: 'ok', rate: 1.5 },
      { from: 'lb', to: 'h2', tone: 'danger', dashed: true, label: 'ejected' },
      { from: 'lb', to: 'h3', tone: 'ok', rate: 1.5 },
    ],
    steps: [
      { from: 'users', to: 'lb', label: 'Requests reach the balancer' },
      { from: 'lb', to: 'h1', label: 'Probe every 2 s: 200 OK' },
      { from: 'lb', to: 'h2', label: 'Three failed probes: ejected', outcome: 'failure' },
      { from: 'lb', to: 'h3', label: 'Traffic now splits across two' },
      { from: 'lb', to: 'h2', label: 'Two passes later: readmitted' },
    ],
  },

  failover: {
    width: 760,
    height: 300,
    caption: 'Detect, fence, promote, repoint. Every step costs seconds you must budget for.',
    nodes: [
      { id: 'app', kind: 'server', label: 'Application', x: 40, y: 110, w: 160, h: 78 },
      { id: 'old', kind: 'sql', label: 'Old primary', sub: 'fenced', x: 300, y: 20, w: 170, h: 80, status: 'down' },
      { id: 'new', kind: 'sql', label: 'Promoted replica', sub: 'new primary', x: 300, y: 185, w: 190, h: 80 },
      { id: 'replica', kind: 'sql', label: 'Replica', x: 580, y: 185, w: 150, h: 76 },
    ],
    edges: [
      { from: 'app', to: 'old', tone: 'muted', dashed: true, label: 'unreachable' },
      { from: 'app', to: 'new', tone: 'ok', rate: 2.4 },
      { from: 'new', to: 'replica', tone: 'violet', rate: 1.2, outcome: 'warning' },
    ],
    steps: [
      { from: 'app', to: 'old', label: 'Health checks fail: primary down', outcome: 'failure' },
      { from: 'app', to: 'old', label: 'Old primary fenced, writes refused', outcome: 'failure' },
      { from: 'app', to: 'new', label: 'Replica promoted, app repointed' },
      { from: 'new', to: 'replica', label: 'Last replica follows new primary' },
    ],
  },

  redundancy: {
    width: 760,
    height: 290,
    caption: 'N+1: losing one instance still leaves enough capacity for peak traffic.',
    nodes: [
      { id: 'traffic', kind: 'client', label: 'Peak traffic', x: 40, y: 105, w: 160, h: 78 },
      { id: 's1', kind: 'server', label: 'Zone A', x: 300, y: 15, w: 160, h: 90, stat: ['CPU', '60%'] },
      { id: 's2', kind: 'server', label: 'Zone B', x: 300, y: 105, w: 160, h: 90, stat: ['CPU', '60%'] },
      { id: 's3', kind: 'server', label: 'Zone C', x: 300, y: 195, w: 160, h: 76, status: 'down' },
      { id: 'ok', kind: 'client', label: 'Still serving', x: 560, y: 105, w: 160, h: 78 },
    ],
    edges: [
      { from: 'traffic', to: 's1', tone: 'ok', rate: 2 },
      { from: 'traffic', to: 's2', tone: 'ok', rate: 2 },
      { from: 'traffic', to: 's3', tone: 'muted', dashed: true },
      { from: 's1', to: 'ok', tone: 'ok', rate: 1.6 },
      { from: 's2', to: 'ok', tone: 'ok', rate: 1.6 },
    ],
    steps: [
      { from: 'traffic', to: 's3', label: 'Zone C goes down', outcome: 'failure' },
      { from: 'traffic', to: 's1', label: 'Zone A absorbs its share' },
      { from: 'traffic', to: 's2', label: 'Zone B too: 40% to 60%' },
      { from: 's1', to: 'ok', label: 'Peak still served: N+1 held' },
    ],
  },

  'single-point-of-failure': {
    width: 760,
    height: 290,
    caption: 'A redundant app tier in front of one database has the availability of that database.',
    nodes: [
      { id: 'lb', kind: 'load-balancer', label: 'Load Balancer x2', x: 40, y: 105, w: 180, h: 78 },
      { id: 's1', kind: 'server', label: 'API 1', x: 300, y: 15, w: 140, h: 72 },
      { id: 's2', kind: 'server', label: 'API 2', x: 300, y: 105, w: 140, h: 72 },
      { id: 's3', kind: 'server', label: 'API 3', x: 300, y: 195, w: 140, h: 72 },
      { id: 'db', kind: 'sql', label: 'Single database', sub: 'SPOF', x: 540, y: 105, w: 190, h: 84, alert: true },
    ],
    edges: [
      { from: 'lb', to: 's1', tone: 'ok', rate: 1.4 },
      { from: 'lb', to: 's2', tone: 'ok', rate: 1.4 },
      { from: 'lb', to: 's3', tone: 'ok', rate: 1.4 },
      { from: 's1', to: 'db', tone: 'danger', rate: 1.4, outcome: 'warning' },
      { from: 's2', to: 'db', tone: 'danger', rate: 1.4, outcome: 'warning' },
      { from: 's3', to: 'db', tone: 'danger', rate: 1.4, outcome: 'warning' },
    ],
    steps: [
      { from: 'lb', to: 's1', label: 'Request lands on any API' },
      { from: 's1', to: 'db', label: 'Every read needs one database', outcome: 'warning' },
      { from: 's2', to: 'db', label: 'Database down: every API fails', outcome: 'failure' },
      { from: 's3', to: 'db', label: 'Redundant tier, same single outage', outcome: 'failure' },
    ],
  },

  'fault-tolerance': {
    width: 760,
    height: 290,
    caption: 'The page renders without recommendations rather than not rendering at all.',
    nodes: [
      { id: 'user', kind: 'client', label: 'User', x: 40, y: 105, w: 140, h: 76 },
      { id: 'api', kind: 'server', label: 'API', sub: 'timeout 200 ms', x: 260, y: 100, w: 170, h: 84 },
      { id: 'recs', kind: 'service', label: 'Recommendations', sub: 'down', x: 520, y: 15, w: 200, h: 80, status: 'down' },
      { id: 'popular', kind: 'cache', label: 'Popular items', sub: 'fallback', x: 520, y: 180, w: 200, h: 80 },
    ],
    edges: [
      { from: 'user', to: 'api', tone: 'brand', rate: 3 },
      { from: 'api', to: 'recs', tone: 'muted', dashed: true, label: 'fails fast' },
      { from: 'api', to: 'popular', tone: 'ok', rate: 2.6, outcome: 'cache-hit' },
    ],
    steps: [
      { from: 'user', to: 'api', label: 'User opens the home page' },
      { from: 'api', to: 'recs', label: 'Recommendations down: 200 ms timeout', outcome: 'failure' },
      { from: 'api', to: 'popular', label: 'Fall back to popular items', outcome: 'cache-hit' },
      { from: 'api', to: 'user', label: 'Page renders, minus personalisation' },
    ],
  },

  'high-availability': {
    width: 760,
    height: 316,
    caption: 'Two zones, automatic promotion, no manual step on the recovery path.',
    nodes: [
      { id: 'lb', kind: 'load-balancer', label: 'Load Balancer', sub: 'managed, multi-zone', x: 290, y: 8, w: 190, h: 76 },
      { id: 'a', kind: 'server', label: 'Zone A - API x3', x: 60, y: 120, w: 190, h: 78 },
      { id: 'b', kind: 'server', label: 'Zone B - API x3', x: 510, y: 120, w: 190, h: 78 },
      { id: 'dba', kind: 'sql', label: 'Primary', x: 90, y: 230, w: 150, h: 72 },
      { id: 'dbb', kind: 'sql', label: 'Standby', x: 530, y: 230, w: 150, h: 72 },
    ],
    edges: [
      { from: 'lb', to: 'a', tone: 'ok', rate: 2.4 },
      { from: 'lb', to: 'b', tone: 'ok', rate: 2.4 },
      { from: 'a', to: 'dba', tone: 'info', rate: 1.6 },
      { from: 'b', to: 'dba', tone: 'info', rate: 1.6 },
      { from: 'dba', to: 'dbb', tone: 'violet', rate: 1.2, label: 'sync', outcome: 'warning' },
      // Where Zone B writes once the standby is promoted.
      { from: 'b', to: 'dbb', tone: 'muted', dashed: true },
    ],
    steps: [
      { from: 'lb', to: 'a', label: 'Traffic spread over two zones' },
      { from: 'lb', to: 'b', label: 'Both zones serve at once' },
      { from: 'b', to: 'dba', label: 'Both zones write the primary' },
      { from: 'dba', to: 'dbb', label: 'Each write synced to standby', outcome: 'warning' },
      { from: 'dba', to: 'dbb', label: 'Zone A lost: sync stops', skipped: true },
      { from: 'b', to: 'dbb', label: 'Standby promoted, Zone B writes it' },
      { from: 'lb', to: 'b', label: 'Zone B serves everything, no human' },
    ],
  },

  'disaster-recovery': {
    width: 760,
    height: 320,
    caption: 'Replication survives a lost region; only a backup undoes a bad write.',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', x: 300, y: 10, w: 160, h: 69 },
      { id: 'prod', kind: 'sql', label: 'Primary DB', sub: 'region A', x: 30, y: 130, w: 180, h: 80 },
      { id: 'standby', kind: 'sql', label: 'Standby DB', sub: 'region B, async', x: 550, y: 130, w: 180, h: 80 },
      { id: 'backup', kind: 'storage', label: 'Backups', sub: 'region B, own account', x: 270, y: 226, w: 220, h: 80 },
    ],
    edges: [
      { from: 'users', to: 'prod', tone: 'ok', rate: 2 },
      { from: 'prod', to: 'standby', tone: 'violet', rate: 1.4, label: 'replication' },
      { from: 'prod', to: 'backup', tone: 'info', rate: 0.5 },
      // Where users go once region A is lost and the standby is promoted.
      { from: 'users', to: 'standby', tone: 'muted', dashed: true },
    ],
    steps: [
      { from: 'users', to: 'prod', label: 'Users write to region A' },
      { from: 'prod', to: 'standby', label: 'Replica trails by seconds' },
      { from: 'prod', to: 'backup', label: 'Hourly backup, other account' },
      { from: 'prod', to: 'standby', label: 'Bad write copied at once', outcome: 'warning' },
      { from: 'backup', to: 'prod', label: 'Only the backup is clean' },
      { from: 'users', to: 'prod', label: 'Region A lost', outcome: 'failure' },
      { from: 'users', to: 'standby', label: 'Standby promoted, users follow' },
    ],
  },

  // ---- Distributed --------------------------------------------------------
  'cap-theorem': {
    width: 760,
    height: 300,
    caption: 'During a partition: reject the write (CP), or accept it and diverge (AP).',
    nodes: [
      { id: 'ca', kind: 'client', label: 'Client A', x: 60, y: 20, w: 150, h: 70 },
      { id: 'cb', kind: 'client', label: 'Client B', x: 550, y: 20, w: 150, h: 70 },
      { id: 'na', kind: 'sql', label: 'Node A', sub: 'majority', x: 60, y: 155, w: 170, h: 96, stat: ['Writes', 'accepted'] },
      { id: 'nb', kind: 'sql', label: 'Node B', sub: 'minority', x: 530, y: 155, w: 170, h: 96, stat: ['Writes', 'rejected'], status: 'degraded' },
    ],
    edges: [
      { from: 'ca', to: 'na', tone: 'ok', rate: 2 },
      { from: 'cb', to: 'nb', tone: 'danger', rate: 2, outcome: 'failure' },
      { from: 'na', to: 'nb', tone: 'danger', dashed: true, label: 'X partition X' },
    ],
    steps: [
      { from: 'ca', to: 'na', label: 'Write on the majority side' },
      { from: 'na', to: 'nb', label: 'Replication is cut', outcome: 'failure' },
      { from: 'cb', to: 'nb', label: 'CP: reject to stay correct', outcome: 'failure' },
    ],
  },

  'strong-consistency': {
    width: 760,
    height: 294,
    caption: 'The write is acknowledged only after a quorum stores it; reads ask the leader.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', x: 40, y: 105, w: 140, h: 74 },
      { id: 'leader', kind: 'sql', label: 'Leader', x: 260, y: 100, w: 160, h: 84 },
      { id: 'f1', kind: 'sql', label: 'Follower 1', sub: 'ack', x: 520, y: 20, w: 170, h: 80 },
      { id: 'f2', kind: 'sql', label: 'Follower 2', sub: 'ack', x: 520, y: 110, w: 170, h: 80 },
      { id: 'f3', kind: 'sql', label: 'Follower 3', sub: 'slow', x: 520, y: 200, w: 170, h: 80, status: 'degraded' },
    ],
    edges: [
      { from: 'client', to: 'leader', tone: 'brand', rate: 2 },
      { from: 'leader', to: 'f1', tone: 'ok', rate: 2 },
      { from: 'leader', to: 'f2', tone: 'ok', rate: 2 },
      { from: 'leader', to: 'f3', tone: 'muted', dashed: true },
    ],
    steps: [
      { from: 'client', to: 'leader', label: 'Write reaches the leader' },
      { from: 'leader', to: 'f1', label: 'Stored on Follower 1' },
      { from: 'leader', to: 'f2', label: 'Stored on Follower 2: quorum' },
      { from: 'leader', to: 'f3', label: 'Slow follower is not awaited', outcome: 'warning' },
      { from: 'leader', to: 'client', label: 'Acknowledged only after quorum' },
      { from: 'client', to: 'leader', label: 'Read asks the leader' },
      { from: 'leader', to: 'client', label: 'Latest acknowledged value, always' },
    ],
  },

  'eventual-consistency': {
    width: 760,
    height: 290,
    caption: 'Every replica answers immediately; they agree a little later.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Write', x: 40, y: 105, w: 140, h: 74 },
      { id: 'a', kind: 'nosql', label: 'Replica A', sub: 'v5', x: 260, y: 100, w: 160, h: 80 },
      { id: 'b', kind: 'nosql', label: 'Replica B', sub: 'v5', x: 520, y: 20, w: 170, h: 80 },
      { id: 'c', kind: 'nosql', label: 'Replica C', sub: 'v4 - stale', x: 520, y: 180, w: 170, h: 80, alert: true },
    ],
    edges: [
      { from: 'client', to: 'a', tone: 'brand', rate: 2.4 },
      { from: 'a', to: 'b', tone: 'ok', rate: 1.4, outcome: 'warning' },
      { from: 'a', to: 'c', tone: 'warn', rate: 0.6, outcome: 'warning', dashed: true, label: '2 s behind' },
    ],
    steps: [
      { from: 'client', to: 'a', label: 'Replica A accepts the write' },
      { from: 'a', to: 'client', label: 'Acked before replication finishes' },
      { from: 'a', to: 'b', label: 'Async copy reaches B: v5' },
      { from: 'a', to: 'c', label: 'C lags 2 s, reads v4', outcome: 'warning' },
    ],
  },

  consensus: {
    width: 760,
    height: 350,
    caption: 'An entry commits once a majority of the 5 nodes stores it - the slow and the crashed follower are not waited for.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', sub: 'write x = 5', x: 20, y: 135, w: 150, h: 74 },
      { id: 'leader', kind: 'server', label: 'Leader', sub: 'term 7, 1 of 5', x: 240, y: 130, w: 170, h: 84 },
      { id: 'f1', kind: 'server', label: 'Follower 1', sub: 'stored', x: 540, y: 5, w: 190, h: 74 },
      { id: 'f2', kind: 'server', label: 'Follower 2', sub: 'stored', x: 540, y: 90, w: 190, h: 74 },
      { id: 'f3', kind: 'server', label: 'Follower 3', sub: 'slow', x: 540, y: 175, w: 190, h: 74, status: 'degraded' },
      { id: 'f4', kind: 'server', label: 'Follower 4', sub: 'crashed', x: 540, y: 260, w: 190, h: 74, status: 'down' },
    ],
    // Every follower is wired to the leader: the leader sends the entry to all
    // four. Only the tone differs - two store it, one lags, one is down.
    edges: [
      { from: 'client', to: 'leader', tone: 'brand', rate: 1.6 },
      { from: 'leader', to: 'f1', tone: 'ok', rate: 1.8 },
      { from: 'leader', to: 'f2', tone: 'ok', rate: 1.8 },
      { from: 'leader', to: 'f3', tone: 'warn', rate: 0.5, outcome: 'warning' },
      { from: 'leader', to: 'f4', tone: 'muted', dashed: true },
    ],
    steps: [
      { from: 'client', to: 'leader', label: 'Write reaches the leader' },
      { from: 'leader', to: 'f1', label: 'Follower 1 stores: 2 of 5' },
      { from: 'leader', to: 'f2', label: 'Follower 2 stores: 3 of 5', outcome: 'cache-hit' },
      { from: 'leader', to: 'f3', label: 'Follower 3 lags, not awaited', outcome: 'warning' },
      { from: 'leader', to: 'f4', label: 'Follower 4 crashed, not needed', skipped: true },
      { from: 'leader', to: 'client', label: 'Majority stored: committed, acknowledged' },
    ],
  },

  'leader-election': {
    width: 760,
    height: 290,
    caption: 'Three nodes, so a majority is 2: the candidate needs one vote besides its own.',
    nodes: [
      { id: 'old', kind: 'server', label: 'Old leader', sub: 'crashed, term 7', x: 30, y: 105, w: 170, h: 80, status: 'down' },
      { id: 'b', kind: 'server', label: 'Node B', sub: 'candidate, term 8', x: 300, y: 15, w: 180, h: 80 },
      { id: 'c', kind: 'server', label: 'Node C', sub: 'follower, term 7', x: 560, y: 195, w: 170, h: 80 },
    ],
    edges: [
      { from: 'old', to: 'b', tone: 'muted', dashed: true },
      { from: 'old', to: 'c', tone: 'muted', dashed: true },
      { from: 'b', to: 'c', tone: 'brand', rate: 1.4 },
    ],
    steps: [
      { from: 'old', to: 'b', label: 'Leader crashed: heartbeats stop', skipped: true },
      { from: 'old', to: 'c', label: 'Node C hears nothing either', skipped: true },
      { from: 'b', to: 'c', label: 'B times out, asks for votes', outcome: 'warning' },
      { from: 'c', to: 'b', label: 'C votes yes: 2 of 3', outcome: 'cache-hit' },
      { from: 'b', to: 'c', label: 'Leader B sends heartbeats' },
    ],
  },

  'distributed-locks': {
    width: 760,
    height: 280,
    caption: 'A paused holder can wake up after its lease expired - the fencing token stops its write.',
    nodes: [
      { id: 'w1', kind: 'worker', label: 'Worker 1', sub: 'token 41, paused', x: 40, y: 20, w: 170, h: 80, status: 'degraded' },
      { id: 'w2', kind: 'worker', label: 'Worker 2', sub: 'token 42', x: 40, y: 165, w: 170, h: 80 },
      { id: 'lock', kind: 'cache', label: 'Lock service', sub: 'lease TTL 30 s', x: 300, y: 95, w: 160, h: 84 },
      { id: 'store', kind: 'storage', label: 'Storage', sub: 'rejects token < 42', x: 550, y: 95, w: 180, h: 84 },
    ],
    edges: [
      { from: 'w1', to: 'lock', tone: 'muted', dashed: true },
      { from: 'w2', to: 'lock', tone: 'ok', rate: 1.4 },
      { from: 'w1', to: 'store', tone: 'danger', rate: 0.8, outcome: 'failure', label: 'stale token', labelT: 0.3 },
      { from: 'w2', to: 'store', tone: 'ok', rate: 1.4 },
    ],
    steps: [
      { from: 'w1', to: 'lock', label: 'Worker 1 takes lease, token 41' },
      { from: 'w2', to: 'lock', label: 'Lease expired: Worker 2, token 42' },
      { from: 'w2', to: 'store', label: 'Write with token 42 accepted' },
      { from: 'w1', to: 'store', label: 'Worker 1 wakes, token 41 rejected', outcome: 'failure' },
    ],
  },

  idempotency: {
    width: 760,
    height: 290,
    caption: 'The same key finds the stored result, so a retry never charges the card twice.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', sub: 'retries on timeout', x: 40, y: 100, w: 170, h: 82 },
      { id: 'api', kind: 'server', label: 'Payments API', sub: 'Idempotency-Key 8f2c', x: 290, y: 95, w: 200, h: 92 },
      { id: 'store', kind: 'sql', label: 'Keys table', sub: 'key -> stored result', x: 570, y: 15, w: 170, h: 80 },
      { id: 'charge', kind: 'sql', label: 'Charges table', sub: 'ch_77, charged once', x: 570, y: 175, w: 170, h: 80 },
    ],
    edges: [
      { from: 'client', to: 'api', tone: 'brand', rate: 3 },
      { from: 'api', to: 'store', tone: 'ok', rate: 2.4, outcome: 'cache-hit' },
      { from: 'api', to: 'charge', tone: 'violet', rate: 0.5 },
    ],
    steps: [
      { from: 'client', to: 'api', label: 'Pay, Idempotency-Key 8f2c' },
      { from: 'api', to: 'store', label: 'New key: saved as in progress' },
      { from: 'api', to: 'charge', label: 'Card charged once: ch_77' },
      { from: 'api', to: 'store', label: 'Same transaction: key completed' },
      { from: 'api', to: 'client', label: 'Response lost on the way', outcome: 'failure' },
      { from: 'client', to: 'api', label: 'Timeout, retry with same key', outcome: 'warning' },
      { from: 'api', to: 'store', label: 'Same key found: completed', outcome: 'cache-hit' },
      { from: 'api', to: 'client', label: 'Stored result, no second charge' },
    ],
  },

  // ---- Architecture -------------------------------------------------------
  monolith: {
    width: 760,
    height: 299,
    caption: 'One deployable unit, one database, in-process calls between features.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Clients', x: 305, y: 10, w: 150, h: 69 },
      { id: 'app', kind: 'server', label: 'Application', sub: 'users | orders | payments', x: 240, y: 105, w: 280, h: 86 },
      { id: 'db', kind: 'sql', label: 'Database', x: 305, y: 215, w: 150, h: 70 },
    ],
    edges: [
      { from: 'client', to: 'app', tone: 'brand', rate: 4 },
      { from: 'app', to: 'db', tone: 'info', rate: 3 },
    ],
    steps: [
      { from: 'client', to: 'app', label: 'Request enters the one process' },
      { from: 'app', to: 'db', label: 'One transaction across all features' },
      { from: 'app', to: 'client', label: 'Response, no network hops inside' },
    ],
  },

  'modular-monolith': {
    width: 760,
    height: 280,
    caption: 'Service-shaped boundaries with no network between them - extraction stays cheap.',
    nodes: [
      { id: 'orders', kind: 'service', label: 'orders', sub: 'module, own tables', x: 60, y: 100, w: 170, h: 80 },
      { id: 'users', kind: 'service', label: 'users', sub: 'module, own tables', x: 500, y: 10, w: 170, h: 80 },
      { id: 'catalog', kind: 'service', label: 'catalog', sub: 'module, own tables', x: 500, y: 100, w: 170, h: 80 },
      { id: 'payments', kind: 'service', label: 'payments', sub: 'module, own tables', x: 500, y: 190, w: 170, h: 80 },
    ],
    // Placing an order is what calls the other modules. A chain (payments
    // calling catalog calling users) would claim dependencies that do not exist.
    edges: [
      { from: 'orders', to: 'users', tone: 'ok', rate: 1.4 },
      { from: 'orders', to: 'catalog', tone: 'ok', rate: 1.4 },
      { from: 'orders', to: 'payments', tone: 'ok', rate: 2 },
    ],
    steps: [
      { from: 'orders', to: 'users', label: 'Check buyer via users interface' },
      { from: 'orders', to: 'catalog', label: 'Prices via catalog interface' },
      { from: 'orders', to: 'payments', label: 'Charge: function call, no network' },
      { from: 'payments', to: 'orders', label: 'Result returned in-process' },
    ],
  },

  microservices: {
    width: 760,
    height: 320,
    caption: 'Independent deployment, own data - and a network call between every box.',
    nodes: [
      { id: 'gw', kind: 'api-gateway', label: 'API Gateway', x: 300, y: 12, w: 170, h: 70 },
      { id: 'users', kind: 'service', label: 'Users Service', x: 40, y: 120, w: 170, h: 76 },
      { id: 'orders', kind: 'service', label: 'Orders Service', x: 295, y: 120, w: 180, h: 76 },
      { id: 'pay', kind: 'service', label: 'Payments Service', x: 560, y: 120, w: 180, h: 76 },
      { id: 'udb', kind: 'sql', label: 'Users DB', x: 55, y: 235, w: 140, h: 70 },
      { id: 'odb', kind: 'sql', label: 'Orders DB', x: 315, y: 235, w: 140, h: 70 },
      { id: 'pdb', kind: 'sql', label: 'Payments DB', x: 580, y: 235, w: 140, h: 70 },
    ],
    edges: [
      { from: 'gw', to: 'users', tone: 'ok', rate: 1.4 },
      { from: 'gw', to: 'orders', tone: 'ok', rate: 2.4 },
      { from: 'gw', to: 'pay', tone: 'ok', rate: 1.4 },
      { from: 'users', to: 'udb', tone: 'info', rate: 1.2 },
      { from: 'orders', to: 'odb', tone: 'info', rate: 1.8 },
      { from: 'pay', to: 'pdb', tone: 'info', rate: 1.2 },
      { from: 'orders', to: 'pay', tone: 'warn', dashed: true, label: 'sync call', rate: 1, outcome: 'warning' },
    ],
    steps: [
      { from: 'gw', to: 'orders', label: 'Checkout routed to Orders' },
      { from: 'orders', to: 'odb', label: 'Order saved in Orders DB' },
      { from: 'orders', to: 'pay', label: 'Network call to Payments', outcome: 'warning' },
      { from: 'pay', to: 'pdb', label: 'Payment stored in its DB' },
      { from: 'gw', to: 'users', label: 'Profile request to Users' },
      { from: 'users', to: 'udb', label: 'Only Users reads Users DB' },
    ],
  },

  cqrs: {
    width: 760,
    height: 290,
    caption: 'Writes shape the domain model; reads are served from a model built for the screen.',
    nodes: [
      { id: 'cmd', kind: 'client', label: 'Command', x: 40, y: 20, w: 150, h: 72 },
      { id: 'write', kind: 'sql', label: 'Write model', sub: 'invariants', x: 280, y: 20, w: 170, h: 80 },
      { id: 'proj', kind: 'worker', label: 'Projection', x: 530, y: 100, w: 160, h: 78 },
      { id: 'read', kind: 'nosql', label: 'Read model', sub: 'denormalised', x: 280, y: 190, w: 170, h: 80 },
      { id: 'query', kind: 'client', label: 'Query', x: 40, y: 190, w: 150, h: 72 },
    ],
    edges: [
      { from: 'cmd', to: 'write', tone: 'brand', rate: 1.4 },
      { from: 'write', to: 'proj', tone: 'violet', rate: 1.4, outcome: 'warning' },
      { from: 'proj', to: 'read', tone: 'violet', rate: 1.4, outcome: 'warning' },
      { from: 'query', to: 'read', tone: 'ok', rate: 4 },
    ],
    steps: [
      { from: 'cmd', to: 'write', label: 'Command validated, then written' },
      { from: 'write', to: 'proj', label: 'Change published asynchronously', outcome: 'warning' },
      { from: 'proj', to: 'read', label: 'Read model updated, a bit later', outcome: 'warning' },
      { from: 'query', to: 'read', label: 'Query reads only the read model' },
      { from: 'read', to: 'query', label: 'Screen-shaped answer, no joins' },
    ],
  },

  'event-sourcing': {
    width: 760,
    height: 280,
    caption: 'Append-only events; current state is a fold over them, with snapshots for speed.',
    nodes: [
      { id: 'cmd', kind: 'client', label: 'Withdraw 30', x: 40, y: 100, w: 160, h: 74 },
      { id: 'stream', kind: 'queue', label: 'account-42 stream', sub: 'immutable events', x: 270, y: 95, w: 200, h: 88 },
      { id: 'snap', kind: 'storage', label: 'Snapshot', sub: 'balance 100 at event 1000', x: 548, y: 20, w: 194, h: 80 },
      { id: 'state', kind: 'sql', label: 'balance 70', sub: 'derived', x: 550, y: 175, w: 170, h: 80 },
    ],
    edges: [
      { from: 'cmd', to: 'stream', tone: 'brand', rate: 2 },
      { from: 'stream', to: 'snap', tone: 'muted', rate: 0.5, dashed: true },
      { from: 'snap', to: 'state', tone: 'violet', rate: 0.8 },
      { from: 'stream', to: 'state', tone: 'ok', rate: 2 },
    ],
    steps: [
      { from: 'cmd', to: 'stream', label: 'Withdrawal appended, nothing overwritten' },
      { from: 'stream', to: 'snap', label: 'Snapshot saved at event 1000' },
      { from: 'snap', to: 'state', label: 'Load state from the snapshot' },
      { from: 'stream', to: 'state', label: 'Replay only events after it' },
    ],
  },

  serverless: {
    width: 960,
    height: 290,
    caption: 'One instance per concurrent event - each one needs a database connection.',
    nodes: [
      { id: 'events', kind: 'client', label: 'Events', sub: 'HTTP, queue, file', x: 12, y: 100, w: 146, h: 86 },
      { id: 'platform', kind: 'api-gateway', label: 'Function platform', sub: 'routes, starts, reclaims', x: 176, y: 96, w: 184, h: 94 },
      { id: 'f1', kind: 'service', label: 'fn instance 1', sub: 'cold start', x: 392, y: 12, w: 150, h: 80, status: 'starting' },
      { id: 'f2', kind: 'service', label: 'fn instance 2', sub: 'warm', x: 392, y: 104, w: 150, h: 80 },
      { id: 'f3', kind: 'service', label: 'fn instance 3', sub: 'warm', x: 392, y: 196, w: 150, h: 80 },
      { id: 'pool', kind: 'api-gateway', label: 'Connection pooler', sub: 'or the DB falls over', x: 576, y: 96, w: 186, h: 94 },
      { id: 'db', kind: 'sql', label: 'Database', sub: 'capped connections', x: 790, y: 100, w: 162, h: 86 },
    ],
    edges: [
      { from: 'events', to: 'platform', tone: 'brand', rate: 2.4 },
      { from: 'platform', to: 'f1', tone: 'warn', rate: 0.8 },
      { from: 'platform', to: 'f2', tone: 'ok', rate: 1.4 },
      { from: 'platform', to: 'f3', tone: 'ok', rate: 1.4 },
      { from: 'f1', to: 'pool', tone: 'info', rate: 0.8 },
      { from: 'f2', to: 'pool', tone: 'info', rate: 1.2 },
      { from: 'f3', to: 'pool', tone: 'info', rate: 1.2 },
      { from: 'pool', to: 'db', tone: 'info', rate: 1.6 },
    ],
    steps: [
      { from: 'events', to: 'platform', label: 'Event reaches the function platform' },
      { from: 'platform', to: 'f2', label: 'An idle instance takes it' },
      { from: 'f2', to: 'pool', label: 'Connects through the pooler' },
      { from: 'pool', to: 'db', label: 'Few real database connections' },
      { from: 'platform', to: 'f3', label: 'Concurrent event, another instance' },
      { from: 'platform', to: 'f1', label: 'No idle instance: cold start', outcome: 'warning' },
    ],
  },

  'service-oriented-architecture': {
    width: 760,
    height: 280,
    caption: 'Logic in the bus is the mistake microservices learned from.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', x: 40, y: 100, w: 140, h: 74 },
      { id: 'bus', kind: 'api-gateway', label: 'Enterprise bus', sub: 'routing + transformation', x: 260, y: 95, w: 210, h: 88, alert: true },
      { id: 'billing', kind: 'service', label: 'Billing', x: 560, y: 20, w: 160, h: 74 },
      { id: 'crm', kind: 'service', label: 'CRM', x: 560, y: 175, w: 160, h: 74 },
    ],
    edges: [
      { from: 'client', to: 'bus', tone: 'brand', rate: 3 },
      { from: 'bus', to: 'billing', tone: 'warn', rate: 1.6 },
      { from: 'bus', to: 'crm', tone: 'warn', rate: 1.6 },
    ],
    steps: [
      { from: 'client', to: 'bus', label: 'Request enters the enterprise bus' },
      { from: 'bus', to: 'billing', label: 'Bus transforms, routes to Billing' },
      { from: 'bus', to: 'crm', label: 'Workflow logic now in bus', outcome: 'warning' },
    ],
  },

  // ---- Security -----------------------------------------------------------
  'rate-limiting': {
    width: 760,
    height: 300,
    caption: 'Allowed requests reach the API; the rest get 429 with Retry-After.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', sub: '100 requests', x: 40, y: 110, w: 150, h: 80 },
      { id: 'limiter', kind: 'api-gateway', label: 'Rate limiter', sub: 'bucket 10, refill 5/s', x: 270, y: 100, w: 190, h: 96, stat: ['Tokens', '3 / 10'] },
      { id: 'api', kind: 'server', label: 'API', x: 560, y: 15, w: 160, h: 76 },
      { id: 'reject', kind: 'client', label: 'HTTP 429', sub: 'Too Many Requests', x: 545, y: 190, w: 190, h: 80 },
    ],
    edges: [
      { from: 'client', to: 'limiter', tone: 'brand', rate: 5 },
      { from: 'limiter', to: 'api', tone: 'ok', rate: 2 },
      { from: 'limiter', to: 'reject', tone: 'danger', rate: 3, outcome: 'failure' },
    ],
    steps: [
      { from: 'client', to: 'limiter', label: 'Burst of 100 arrives' },
      { from: 'limiter', to: 'api', label: 'Tokens available: allowed' },
      { from: 'limiter', to: 'reject', label: 'Bucket empty: 429 + Retry-After', outcome: 'failure' },
    ],
  },

  authentication: {
    width: 760,
    height: 290,
    caption: 'Verify the password once, then check the session on every later request.',
    nodes: [
      { id: 'browser', kind: 'client', label: 'Browser', x: 30, y: 105, w: 150, h: 76 },
      { id: 'login', kind: 'api-gateway', label: 'Login endpoint', sub: 'bcrypt verify', x: 270, y: 15, w: 190, h: 84 },
      { id: 'api', kind: 'server', label: 'API', sub: 'checks the cookie', x: 270, y: 190, w: 190, h: 84 },
      { id: 'sessions', kind: 'cache', label: 'Session store', sub: 'sid -> user 42', x: 560, y: 102, w: 180, h: 84 },
    ],
    edges: [
      { from: 'browser', to: 'login', tone: 'violet', rate: 1 },
      { from: 'login', to: 'sessions', tone: 'violet', rate: 1 },
      { from: 'browser', to: 'api', tone: 'brand', rate: 2.4 },
      { from: 'api', to: 'sessions', tone: 'brand', rate: 2.4 },
    ],
    steps: [
      { from: 'browser', to: 'login', label: 'Password sent once' },
      { from: 'login', to: 'sessions', label: 'Hash matches: session stored' },
      { from: 'login', to: 'browser', label: 'HttpOnly session cookie set' },
      { from: 'browser', to: 'api', label: 'Later request carries the cookie' },
      { from: 'api', to: 'sessions', label: 'Session found: user 42' },
      { from: 'api', to: 'browser', label: 'No valid cookie: 401', outcome: 'failure' },
    ],
  },

  authorization: {
    width: 800,
    height: 270,
    caption: 'Authentication says who you are. Authorization checks this invoice belongs to you.',
    nodes: [
      { id: 'req', kind: 'client', label: 'Alice', sub: 'user 42, tenant 3', x: 20, y: 95, w: 160, h: 84 },
      { id: 'gw', kind: 'api-gateway', label: 'Gateway', sub: 'identity check', x: 220, y: 95, w: 150, h: 84 },
      { id: 'svc', kind: 'service', label: 'Invoices service', sub: 'permission check', x: 410, y: 95, w: 190, h: 84 },
      { id: 'db', kind: 'sql', label: 'Invoices DB', sub: '9182: tenant 7', x: 640, y: 95, w: 140, h: 84 },
    ],
    edges: [
      { from: 'req', to: 'gw', tone: 'brand', rate: 2 },
      { from: 'gw', to: 'svc', tone: 'brand', rate: 2 },
      { from: 'svc', to: 'db', tone: 'default', rate: 2 },
    ],
    steps: [
      { from: 'req', to: 'gw', label: 'GET /invoices/9182 with cookie' },
      { from: 'gw', to: 'svc', label: 'Identity known: user 42' },
      { from: 'svc', to: 'db', label: 'Load invoice 9182' },
      { from: 'db', to: 'svc', label: 'It belongs to tenant 7' },
      { from: 'svc', to: 'gw', label: 'Tenant 7 is not 3: 403', outcome: 'failure' },
      { from: 'gw', to: 'req', label: '403 Forbidden, no data', outcome: 'failure' },
    ],
  },

  jwt: {
    width: 760,
    height: 289,
    caption: 'Every service verifies the signature locally - no lookup, and no easy revocation.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Bearer eyJhbGc...', x: 40, y: 95, w: 180, h: 78 },
      { id: 's1', kind: 'service', label: 'Service A', sub: 'verifies locally', x: 320, y: 15, w: 180, h: 80 },
      { id: 's2', kind: 'service', label: 'Service B', sub: 'verifies locally', x: 320, y: 105, w: 180, h: 80 },
      { id: 's3', kind: 'service', label: 'Service C', sub: 'verifies locally', x: 320, y: 195, w: 180, h: 80 },
      { id: 'keys', kind: 'storage', label: 'Public key', sub: 'JWKS, cached', x: 590, y: 105, w: 140, h: 80 },
    ],
    edges: [
      { from: 'client', to: 's1', tone: 'brand', rate: 1.6 },
      { from: 'client', to: 's2', tone: 'brand', rate: 1.6 },
      { from: 'client', to: 's3', tone: 'brand', rate: 1.6 },
      // Every service fetches the public key, not just one of them - that is
      // exactly what makes local verification possible everywhere.
      { from: 's1', to: 'keys', tone: 'muted', dashed: true },
      { from: 's2', to: 'keys', tone: 'muted', dashed: true },
      { from: 's3', to: 'keys', tone: 'muted', dashed: true },
    ],
    steps: [
      { from: 'client', to: 's1', label: 'Service A verifies the signature' },
      { from: 's1', to: 'keys', label: 'Public key fetched once, cached' },
      { from: 'client', to: 's2', label: 'Service B verifies, no auth call' },
      { from: 'client', to: 's3', label: 'Revoked token passes until expiry', outcome: 'warning' },
    ],
  },

  oauth: {
    width: 760,
    height: 280,
    caption: 'The app never sees the password - only a scoped, revocable token.',
    nodes: [
      { id: 'user', kind: 'client', label: 'User', sub: 'browser', x: 40, y: 15, w: 130, h: 82 },
      { id: 'app', kind: 'server', label: 'Client app', x: 230, y: 95, w: 150, h: 78 },
      { id: 'auth', kind: 'api-gateway', label: 'Authorization server', sub: 'login + consent', x: 480, y: 15, w: 200, h: 82 },
      { id: 'res', kind: 'service', label: 'Resource server', sub: 'checks scopes', x: 480, y: 180, w: 200, h: 82 },
    ],
    edges: [
      { from: 'user', to: 'app', tone: 'brand', rate: 1.6 },
      // The user signs in at the authorization server itself - that direct hop
      // is why the client app never sees the password.
      { from: 'user', to: 'auth', tone: 'violet', rate: 1 },
      // The back channel: code + code_verifier in, tokens out.
      { from: 'app', to: 'auth', tone: 'violet', rate: 1.4 },
      { from: 'app', to: 'res', tone: 'ok', rate: 2, label: 'access token' },
    ],
    // Both redirects travel through the browser (app -> user -> auth, then
    // auth -> user -> app); only the code-for-token exchange is a direct call.
    steps: [
      { from: 'user', to: 'app', label: 'User clicks Sign in' },
      { from: 'app', to: 'user', label: 'Redirect carries PKCE challenge' },
      { from: 'user', to: 'auth', label: 'Password and consent go here' },
      { from: 'auth', to: 'user', label: 'Redirect back with one-time code' },
      { from: 'user', to: 'app', label: 'Browser hands code to app' },
      { from: 'app', to: 'auth', label: 'Code plus verifier to /token' },
      { from: 'auth', to: 'app', label: 'Scoped access token issued' },
      { from: 'app', to: 'res', label: 'API call with access token' },
      { from: 'res', to: 'app', label: 'Scopes checked, data returned' },
    ],
  },

  'tls-https': {
    width: 760,
    height: 240,
    caption: 'One round trip in TLS 1.3, then everything on the wire is encrypted.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Browser', sub: 'trusted root CAs', x: 40, y: 80, w: 160, h: 80 },
      { id: 'path', kind: 'service', label: 'Network path', sub: 'Wi-Fi, ISP routers', x: 300, y: 80, w: 160, h: 80 },
      { id: 'server', kind: 'server', label: 'example.com', sub: 'certificate + private key', x: 545, y: 80, w: 195, h: 80 },
    ],
    edges: [
      { from: 'client', to: 'path', tone: 'brand', rate: 2.4 },
      { from: 'path', to: 'server', tone: 'ok', rate: 2.4 },
    ],
    steps: [
      { from: 'client', to: 'path', label: 'ClientHello with key share' },
      { from: 'path', to: 'server', label: 'Routers forward it unchanged' },
      { from: 'server', to: 'path', label: 'Certificate plus server key share' },
      { from: 'path', to: 'client', label: 'Chain checked against trusted roots' },
      { from: 'client', to: 'path', label: 'HTTP request, now encrypted' },
      { from: 'path', to: 'server', label: 'Routers see only ciphertext' },
    ],
  },

  waf: {
    width: 760,
    height: 290,
    caption: 'Known-bad requests get a 403 at the edge, before they reach your code.',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', sub: 'normal requests', x: 30, y: 20, w: 160, h: 80 },
      { id: 'attacker', kind: 'client', label: 'Attacker', sub: 'SQLi, XSS, bots', x: 30, y: 185, w: 160, h: 80 },
      { id: 'waf', kind: 'api-gateway', label: 'WAF', sub: 'rules, anomaly score', x: 285, y: 100, w: 180, h: 90 },
      { id: 'app', kind: 'server', label: 'Application', x: 570, y: 20, w: 160, h: 80 },
      { id: 'log', kind: 'monitoring', label: 'WAF log', sub: 'rule id, request id', x: 570, y: 185, w: 160, h: 80 },
    ],
    edges: [
      { from: 'users', to: 'waf', tone: 'brand', rate: 2.4 },
      { from: 'attacker', to: 'waf', tone: 'danger', rate: 1.4, outcome: 'warning' },
      { from: 'waf', to: 'attacker', tone: 'danger', rate: 1.2, outcome: 'failure', curvature: 0.9 },
      { from: 'waf', to: 'app', tone: 'ok', rate: 2.4 },
      { from: 'waf', to: 'log', tone: 'warn', rate: 1.2, outcome: 'cache-hit', dashed: true },
    ],
    steps: [
      { from: 'users', to: 'waf', label: 'Every request inspected at edge' },
      { from: 'waf', to: 'app', label: 'No rule matched: forwarded' },
      { from: 'attacker', to: 'waf', label: 'SQL injection in the query', outcome: 'warning' },
      { from: 'waf', to: 'log', label: 'Match logged with rule id' },
      { from: 'waf', to: 'attacker', label: 'Blocked: 403 Forbidden', outcome: 'failure' },
    ],
  },

  'api-keys': {
    width: 760,
    height: 300,
    caption: 'The key identifies the integration, so you can meter and revoke it alone.',
    nodes: [
      { id: 'i1', kind: 'client', label: 'Integration A', sub: 'sk_live_9f2c', x: 40, y: 20, w: 180, h: 80 },
      { id: 'i2', kind: 'client', label: 'Integration B', sub: 'sk_live_44ab', x: 40, y: 130, w: 180, h: 80 },
      { id: 'gw', kind: 'api-gateway', label: 'Gateway', sub: 'quota per key', x: 320, y: 75, w: 170, h: 84 },
      { id: 'keys', kind: 'sql', label: 'Key store', sub: 'SHA-256 hashes', x: 320, y: 205, w: 170, h: 80 },
      { id: 'api', kind: 'server', label: 'API', x: 580, y: 77, w: 150, h: 80 },
    ],
    edges: [
      { from: 'i1', to: 'gw', tone: 'ok', rate: 2 },
      { from: 'i2', to: 'gw', tone: 'danger', rate: 3.4, outcome: 'failure', label: 'over quota' },
      { from: 'gw', to: 'keys', tone: 'violet', rate: 2 },
      { from: 'gw', to: 'api', tone: 'ok', rate: 2 },
    ],
    steps: [
      { from: 'i1', to: 'gw', label: 'Integration A sends its key' },
      { from: 'gw', to: 'keys', label: 'Hash found: Integration A' },
      { from: 'gw', to: 'api', label: 'Within quota: forwarded' },
      { from: 'gw', to: 'i2', label: 'B over its quota: 429', outcome: 'failure' },
    ],
  },

  'secrets-management': {
    width: 760,
    height: 290,
    caption: 'Short-lived credentials issued at runtime - nothing static in the repo or the image.',
    nodes: [
      { id: 'wl', kind: 'server', label: 'Workload', sub: 'workload identity', x: 40, y: 180, w: 180, h: 88 },
      { id: 'vault', kind: 'storage', label: 'Secret manager', sub: 'audits every read', x: 280, y: 16, w: 200, h: 88 },
      { id: 'db', kind: 'sql', label: 'Database', sub: 'user valid 1 hour', x: 540, y: 180, w: 180, h: 88 },
    ],
    edges: [
      { from: 'wl', to: 'vault', tone: 'brand', rate: 0.5 },
      { from: 'vault', to: 'db', tone: 'violet', rate: 0.5 },
      { from: 'wl', to: 'db', tone: 'ok', rate: 2 },
    ],
    steps: [
      { from: 'wl', to: 'vault', label: 'Workload proves its identity' },
      { from: 'vault', to: 'db', label: 'Creates a 1-hour database user' },
      { from: 'vault', to: 'wl', label: 'Credential delivered at runtime' },
      { from: 'wl', to: 'db', label: 'Workload logs in with it' },
      { from: 'vault', to: 'db', label: 'Lease ends: user dropped' },
    ],
  },

  // ---- Communication ------------------------------------------------------
  'rest-apis': {
    width: 760,
    height: 280,
    caption: 'GET is cacheable and safe to retry. POST is neither.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', x: 40, y: 95, w: 140, h: 78 },
      { id: 'cache', kind: 'cdn', label: 'Cache / proxy', sub: 'understands GET', x: 260, y: 90, w: 180, h: 88 },
      { id: 'api', kind: 'server', label: '/orders/123', x: 540, y: 90, w: 180, h: 84 },
    ],
    edges: [
      { from: 'client', to: 'cache', tone: 'brand', rate: 3.4 },
      { from: 'cache', to: 'api', tone: 'ok', rate: 1.2, label: 'on miss' },
    ],
    steps: [
      { from: 'client', to: 'cache', label: 'GET /orders/123' },
      { from: 'cache', to: 'api', label: 'Miss: forwarded to the origin' },
      { from: 'api', to: 'cache', label: 'Cacheable response stored' },
      { from: 'cache', to: 'client', label: 'Repeat GET answered by cache', outcome: 'cache-hit' },
      { from: 'cache', to: 'api', label: 'POST always passes through' },
    ],
  },

  graphql: {
    width: 760,
    height: 290,
    caption: 'One query, exactly the requested fields - and an N+1 risk behind every resolver.',
    nodes: [
      { id: 'client', kind: 'client', label: 'One query', x: 40, y: 100, w: 150, h: 78 },
      { id: 'gql', kind: 'server', label: 'GraphQL server', sub: 'resolvers + batching', x: 270, y: 95, w: 200, h: 90 },
      { id: 'orders', kind: 'sql', label: 'Orders DB', x: 560, y: 15, w: 160, h: 72 },
      { id: 'customers', kind: 'service', label: 'Users service', x: 560, y: 100, w: 160, h: 72 },
      { id: 'items', kind: 'nosql', label: 'Catalog DB', x: 560, y: 185, w: 160, h: 72 },
    ],
    edges: [
      { from: 'client', to: 'gql', tone: 'brand', rate: 2 },
      { from: 'gql', to: 'orders', tone: 'info', rate: 1.6 },
      { from: 'gql', to: 'customers', tone: 'info', rate: 1.6 },
      { from: 'gql', to: 'items', tone: 'info', rate: 1.6 },
    ],
    steps: [
      { from: 'client', to: 'gql', label: 'One query, only needed fields' },
      { from: 'gql', to: 'orders', label: 'Resolver loads the orders' },
      { from: 'gql', to: 'customers', label: 'Customers batched into one call' },
      { from: 'gql', to: 'items', label: 'Products batched too, no N+1' },
      { from: 'gql', to: 'client', label: 'Exactly the requested shape' },
    ],
  },

  grpc: {
    width: 760,
    height: 270,
    caption: 'gRPC between services over one HTTP/2 connection; REST and JSON at the browser edge.',
    nodes: [
      { id: 'browser', kind: 'client', label: 'Browser', x: 30, y: 90, w: 140, h: 80 },
      { id: 'a', kind: 'service', label: 'Checkout', sub: 'generated gRPC stub', x: 280, y: 88, w: 190, h: 84 },
      { id: 'b', kind: 'service', label: 'Pricing', sub: '.proto contract', x: 580, y: 88, w: 160, h: 84 },
    ],
    edges: [
      { from: 'browser', to: 'a', tone: 'info', rate: 1.2, label: 'JSON' },
      { from: 'a', to: 'b', tone: 'brand', rate: 5, label: 'gRPC, HTTP/2' },
    ],
    steps: [
      { from: 'browser', to: 'a', label: 'Browser calls REST with JSON' },
      { from: 'a', to: 'b', label: 'Stub sends a binary protobuf call' },
      { from: 'a', to: 'b', label: 'More calls share one connection' },
      { from: 'b', to: 'a', label: 'Typed reply, checked against .proto' },
      { from: 'a', to: 'browser', label: 'JSON answer back to the browser' },
    ],
  },

  websockets: {
    asymmetric: 'The socket lives on one gateway node; the other reaches the user through pub/sub.',
    width: 760,
    height: 290,
    caption: 'The connection is state: the node holding it must be reachable to deliver a message.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', x: 40, y: 100, w: 140, h: 78 },
      { id: 'gw', kind: 'service', label: 'Gateway node 2', sub: 'holds the socket', x: 260, y: 95, w: 190, h: 88 },
      { id: 'bus', kind: 'queue', label: 'Pub/Sub', x: 540, y: 15, w: 170, h: 74 },
      { id: 'other', kind: 'service', label: 'Gateway node 7', x: 540, y: 180, w: 170, h: 76 },
    ],
    edges: [
      { from: 'client', to: 'gw', tone: 'brand', rate: 2.6 },
      { from: 'gw', to: 'client', tone: 'ok', rate: 2.6, curvature: 0.9 },
      { from: 'other', to: 'bus', tone: 'warn', rate: 1.4 },
      { from: 'bus', to: 'gw', tone: 'warn', rate: 1.4 },
    ],
    steps: [
      { from: 'client', to: 'gw', label: 'HTTP upgrade, socket stays open' },
      { from: 'other', to: 'bus', label: 'Node 7 publishes for the user' },
      { from: 'bus', to: 'gw', label: 'Pub/Sub reaches the socket holder' },
      { from: 'gw', to: 'client', label: 'Pushed down the open socket' },
    ],
  },

  'server-sent-events': {
    width: 760,
    height: 260,
    caption: 'One long-lived HTTP response, server to client only, with automatic reconnect.',
    nodes: [
      { id: 'client', kind: 'client', label: 'EventSource', x: 60, y: 90, w: 170, h: 78 },
      { id: 'server', kind: 'server', label: 'text/event-stream', sub: 'id + data frames', x: 320, y: 85, w: 200, h: 88 },
      { id: 'src', kind: 'queue', label: 'Updates', x: 600, y: 90, w: 130, h: 78 },
    ],
    edges: [
      { from: 'src', to: 'server', tone: 'warn', rate: 1.6 },
      { from: 'server', to: 'client', tone: 'ok', rate: 2.4 },
    ],
    steps: [
      { from: 'client', to: 'server', label: 'EventSource opens one request' },
      { from: 'src', to: 'server', label: 'An update arrives' },
      { from: 'server', to: 'client', label: 'Streamed as an event, id 42' },
      { from: 'client', to: 'server', label: 'Dropped? Reconnect with Last-Event-ID', outcome: 'warning' },
    ],
  },

  polling: {
    width: 760,
    height: 290,
    caption: '10,000 clients every 5 s is 2,000 req/sec - even when nothing changed.',
    nodes: [
      { id: 'clients', kind: 'client', label: '10,000 clients', sub: 'every 5 s', x: 40, y: 100, w: 180, h: 82 },
      { id: 'api', kind: 'server', label: 'API', sub: '2,000 req/sec', x: 320, y: 100, w: 170, h: 82, alert: true },
      { id: 'data', kind: 'sql', label: 'Data store', sub: 'changes once a minute', x: 566, y: 100, w: 177, h: 82 },
    ],
    edges: [
      { from: 'clients', to: 'api', tone: 'brand', rate: 6 },
      { from: 'api', to: 'clients', tone: 'muted', rate: 5, outcome: 'warning', curvature: 0.9 },
      { from: 'api', to: 'data', tone: 'default', rate: 2 },
    ],
    steps: [
      { from: 'clients', to: 'api', label: 'Poll with If-None-Match' },
      { from: 'api', to: 'data', label: 'Compare ETag with current version' },
      { from: 'api', to: 'clients', label: 'Unchanged: a cheap 304', outcome: 'warning' },
      { from: 'clients', to: 'api', label: 'Five seconds later, ask again', outcome: 'warning' },
    ],
  },

  'long-polling': {
    width: 760,
    height: 260,
    caption: 'The request is held open until there is something to send.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Client', x: 60, y: 90, w: 150, h: 78 },
      { id: 'server', kind: 'server', label: 'Held request', sub: 'up to 30 s', x: 300, y: 85, w: 180, h: 88 },
      { id: 'event', kind: 'queue', label: 'Pub/Sub', sub: 'wakes the waiter', x: 570, y: 85, w: 160, h: 88 },
    ],
    edges: [
      { from: 'client', to: 'server', tone: 'brand', rate: 1 },
      { from: 'event', to: 'server', tone: 'warn', rate: 1 },
      { from: 'server', to: 'client', tone: 'ok', rate: 1, curvature: 0.9 },
    ],
    steps: [
      { from: 'client', to: 'server', label: 'Request parked, up to 30 s' },
      { from: 'event', to: 'server', label: 'An event arrives' },
      { from: 'server', to: 'client', label: 'Held request completes at once' },
      { from: 'client', to: 'server', label: 'Next request sent immediately' },
    ],
  },

  // ---- Observability ------------------------------------------------------
  'distributed-tracing': {
    width: 760,
    height: 309,
    caption: 'One trace_id crosses every hop, including the queue - otherwise half the trace is missing.',
    nodes: [
      { id: 'gw', kind: 'api-gateway', label: 'Gateway', sub: '260 ms total', x: 20, y: 110, w: 150, h: 80 },
      { id: 'order', kind: 'service', label: 'Order', sub: '242 ms', x: 210, y: 110, w: 150, h: 80 },
      { id: 'inv', kind: 'service', label: 'Inventory', sub: '55 ms', x: 400, y: 15, w: 160, h: 80 },
      { id: 'pay', kind: 'service', label: 'Payment', sub: '145 ms, 120 self', x: 400, y: 205, w: 160, h: 80, alert: true },
      { id: 'db', kind: 'sql', label: 'Database', sub: '25 ms a query', x: 600, y: 110, w: 140, h: 80 },
      { id: 'queue', kind: 'queue', label: 'Kafka', sub: 'context in headers', x: 190, y: 215, w: 180, h: 80 },
    ],
    edges: [
      { from: 'gw', to: 'order', tone: 'brand', rate: 2 },
      { from: 'order', to: 'inv', tone: 'brand', rate: 2 },
      { from: 'inv', to: 'db', tone: 'info', rate: 2 },
      { from: 'order', to: 'pay', tone: 'warn', rate: 2, outcome: 'warning' },
      { from: 'pay', to: 'db', tone: 'info', rate: 2 },
      { from: 'order', to: 'queue', tone: 'muted', dashed: true, rate: 0.8 },
    ],
    steps: [
      { from: 'gw', to: 'order', label: 'traceparent header sent on' },
      { from: 'order', to: 'inv', label: 'Child span: reserve stock' },
      { from: 'inv', to: 'db', label: 'Query span, 25 ms' },
      { from: 'order', to: 'pay', label: 'Payment: 120 ms its own', outcome: 'warning' },
      { from: 'pay', to: 'db', label: 'Database only 25 ms' },
      { from: 'order', to: 'queue', label: 'Context crosses the broker' },
    ],
  },

  monitoring: {
    width: 760,
    height: 290,
    caption: 'Four golden signals in, one decision out: does a human need to wake up?',
    nodes: [
      { id: 'api', kind: 'server', label: 'Services', x: 40, y: 100, w: 150, h: 80 },
      { id: 'metrics', kind: 'monitoring', label: 'Metrics', sub: 'latency, errors', x: 280, y: 15, w: 170, h: 80 },
      { id: 'logs', kind: 'storage', label: 'Logs', sub: 'trace_id', x: 280, y: 105, w: 170, h: 80 },
      { id: 'traces', kind: 'search', label: 'Traces', x: 280, y: 195, w: 170, h: 76 },
      { id: 'alert', kind: 'client', label: 'Page on-call', sub: 'burn rate 14x', x: 540, y: 105, w: 180, h: 80 },
    ],
    edges: [
      { from: 'api', to: 'metrics', tone: 'ok', rate: 2 },
      { from: 'api', to: 'logs', tone: 'ok', rate: 2 },
      { from: 'api', to: 'traces', tone: 'ok', rate: 1.4 },
      { from: 'metrics', to: 'alert', tone: 'danger', rate: 1.2, outcome: 'failure' },
    ],
    steps: [
      { from: 'api', to: 'logs', label: 'Events logged with trace_id' },
      { from: 'api', to: 'traces', label: 'Request traces sampled' },
      { from: 'api', to: 'metrics', label: 'Latency and errors as metrics' },
      { from: 'metrics', to: 'alert', label: 'Burn rate 14x: page on-call', outcome: 'failure' },
    ],
  },

  logging: {
    width: 760,
    height: 260,
    caption: 'Structured lines with a trace id reconstruct one request across every service.',
    nodes: [
      { id: 's1', kind: 'service', label: 'Service A', x: 40, y: 30, w: 160, h: 72 },
      { id: 's2', kind: 'service', label: 'Service B', x: 40, y: 135, w: 160, h: 72 },
      { id: 'pipe', kind: 'queue', label: 'Log pipeline', x: 300, y: 85, w: 170, h: 80 },
      { id: 'search', kind: 'search', label: 'Search by trace_id', x: 550, y: 85, w: 190, h: 80 },
    ],
    edges: [
      { from: 's1', to: 'pipe', tone: 'ok', rate: 2.4 },
      { from: 's2', to: 'pipe', tone: 'ok', rate: 2.4 },
      { from: 'pipe', to: 'search', tone: 'brand', rate: 2.4 },
    ],
    steps: [
      { from: 's1', to: 'pipe', label: 'Service A logs JSON, trace_id' },
      { from: 's2', to: 'pipe', label: 'Service B logs the same trace_id' },
      { from: 'pipe', to: 'search', label: 'One search rebuilds the request' },
    ],
  },

  metrics: {
    width: 760,
    height: 260,
    caption: 'Cheap aggregates at high resolution - percentiles, not averages.',
    nodes: [
      { id: 'app', kind: 'server', label: 'Instrumented app', x: 40, y: 90, w: 190, h: 80 },
      { id: 'tsdb', kind: 'monitoring', label: 'Time series DB', sub: 'p50 / p95 / p99', x: 310, y: 85, w: 190, h: 88 },
      { id: 'dash', kind: 'client', label: 'Dashboard', x: 580, y: 90, w: 150, h: 80 },
    ],
    edges: [
      { from: 'app', to: 'tsdb', tone: 'ok', rate: 4 },
      { from: 'tsdb', to: 'dash', tone: 'brand', rate: 2 },
    ],
    steps: [
      { from: 'app', to: 'tsdb', label: 'Latency recorded as a histogram' },
      { from: 'dash', to: 'tsdb', label: 'Dashboard asks for p99' },
      { from: 'tsdb', to: 'dash', label: 'p99 shows the slow tail' },
    ],
  },

  // ---- Patterns -----------------------------------------------------------
  'fan-out': {
    width: 760,
    height: 290,
    caption: 'Fan-out on write: one write per follower, one lookup per read.',
    asymmetric: 'Each timeline belongs to one follower, so only Follower 1 reads Timeline 1; the other readers are not drawn.',
    nodes: [
      { id: 'post', kind: 'client', label: 'New post', sub: '5,000 followers', x: 20, y: 105, w: 150, h: 80 },
      { id: 'fan', kind: 'worker', label: 'Fan-out worker', x: 215, y: 103, w: 175, h: 84 },
      { id: 't1', kind: 'cache', label: 'Timeline 1', x: 435, y: 15, w: 160, h: 70 },
      { id: 't2', kind: 'cache', label: 'Timeline 2', x: 435, y: 110, w: 160, h: 70 },
      { id: 't3', kind: 'cache', label: 'Timeline 5,000', x: 435, y: 205, w: 170, h: 70 },
      { id: 'reader', kind: 'client', label: 'Follower 1', x: 630, y: 15, w: 125, h: 70 },
    ],
    edges: [
      { from: 'post', to: 'fan', tone: 'brand', rate: 1.4 },
      { from: 'fan', to: 't1', tone: 'ok', rate: 2.4 },
      { from: 'fan', to: 't2', tone: 'ok', rate: 2.4 },
      { from: 'fan', to: 't3', tone: 'warn', rate: 2.4, outcome: 'warning' },
      { from: 'reader', to: 't1', tone: 'info', rate: 1.2 },
    ],
    steps: [
      { from: 'post', to: 'fan', label: 'New post queued for fan-out' },
      { from: 'fan', to: 't1', label: 'Written into each follower timeline' },
      { from: 'fan', to: 't2', label: 'One write per follower' },
      { from: 'fan', to: 't3', label: '5,000 followers: 5,000 writes', outcome: 'warning' },
      { from: 'reader', to: 't1', label: 'Follower opens feed: one lookup' },
      { from: 't1', to: 'reader', label: 'Timeline already built' },
    ],
  },

  backpressure: {
    width: 760,
    height: 290,
    caption: 'A bounded queue refuses new work, and the refusal travels back upstream.',
    nodes: [
      { id: 'clients', kind: 'client', label: 'Clients', x: 20, y: 105, w: 130, h: 80 },
      { id: 'prod', kind: 'server', label: 'Producer', sub: '1,000/s', x: 190, y: 105, w: 150, h: 80 },
      { id: 'queue', kind: 'queue', label: 'Bounded queue', sub: '10,000 max', x: 380, y: 97, w: 190, h: 96, stat: ['Full', 'yes'], alert: true },
      { id: 'cons', kind: 'worker', label: 'Consumers', sub: '400/s', x: 610, y: 105, w: 140, h: 80 },
    ],
    edges: [
      { from: 'clients', to: 'prod', tone: 'brand', rate: 5 },
      { from: 'prod', to: 'queue', tone: 'brand', rate: 5 },
      { from: 'queue', to: 'cons', tone: 'ok', rate: 2 },
    ],
    steps: [
      { from: 'clients', to: 'prod', label: 'Clients send 1,000/s' },
      { from: 'prod', to: 'queue', label: 'Producer publishes to bounded queue' },
      { from: 'queue', to: 'cons', label: 'Consumers drain only 400/s' },
      { from: 'queue', to: 'prod', label: 'Full at 10,000: publish refused', outcome: 'failure' },
      { from: 'prod', to: 'clients', label: '429 with Retry-After upstream', outcome: 'failure' },
    ],
  },

  bulkhead: {
    width: 760,
    height: 294,
    caption: 'Separate pools inside the API: a hung dependency fills only its own threads.',
    nodes: [
      { id: 'users', kind: 'client', label: 'Users', x: 16, y: 105, w: 110, h: 80 },
      { id: 'api', kind: 'server', label: 'API', sub: '200 threads', x: 160, y: 105, w: 130, h: 80 },
      { id: 'p1', kind: 'worker', label: 'Recs pool', sub: '20 threads, full', x: 330, y: 10, w: 180, h: 80, status: 'degraded' },
      { id: 'p2', kind: 'worker', label: 'Checkout pool', sub: '80 threads', x: 330, y: 105, w: 180, h: 80 },
      { id: 'p3', kind: 'worker', label: 'Search pool', sub: '60 threads', x: 330, y: 200, w: 180, h: 80 },
      { id: 'recs', kind: 'service', label: 'Recommendations', sub: 'hangs 30 s', x: 560, y: 10, w: 184, h: 80, status: 'down' },
      { id: 'pay', kind: 'service', label: 'Payments', sub: '~100 ms', x: 560, y: 105, w: 184, h: 80 },
      { id: 'search', kind: 'search', label: 'Search', sub: '~50 ms', x: 560, y: 200, w: 184, h: 80 },
    ],
    edges: [
      { from: 'users', to: 'api', tone: 'brand', rate: 3 },
      { from: 'api', to: 'p1', tone: 'warn', rate: 0.8, outcome: 'warning' },
      { from: 'api', to: 'p2', tone: 'ok', rate: 1.4 },
      { from: 'api', to: 'p3', tone: 'ok', rate: 1 },
      { from: 'p1', to: 'recs', tone: 'danger', rate: 0.4, outcome: 'failure' },
      { from: 'p2', to: 'pay', tone: 'ok', rate: 1.4 },
      { from: 'p3', to: 'search', tone: 'ok', rate: 1 },
    ],
    steps: [
      { from: 'users', to: 'api', label: 'Requests share one API' },
      { from: 'p1', to: 'recs', label: 'Recs hangs: 20 threads stuck', outcome: 'failure' },
      { from: 'api', to: 'p1', label: 'Recs pool full: fallback', outcome: 'warning' },
      { from: 'api', to: 'p2', label: 'Checkout uses its own pool' },
      { from: 'p2', to: 'pay', label: 'Checkout still completes' },
      { from: 'api', to: 'p3', label: 'Search pool unaffected too' },
      { from: 'p3', to: 'search', label: 'Search answers normally' },
    ],
  },

  'saga-pattern': {
    width: 760,
    height: 310,
    caption: 'Shipping failed, so the orchestrator compensates steps 3, 2 and 1 in reverse.',
    nodes: [
      { id: 'client', kind: 'client', label: 'Customer', x: 20, y: 118, w: 130, h: 74 },
      { id: 'orch', kind: 'service', label: 'Order service', sub: 'saga orchestrator', x: 200, y: 110, w: 190, h: 90 },
      { id: 'inv', kind: 'service', label: 'Inventory', sub: 'reserve / release', x: 520, y: 15, w: 210, h: 80 },
      { id: 'pay', kind: 'service', label: 'Payment', sub: 'charge / refund', x: 520, y: 115, w: 210, h: 80 },
      { id: 'ship', kind: 'service', label: 'Shipping', sub: 'address rejected', x: 520, y: 215, w: 210, h: 80, status: 'down' },
    ],
    edges: [
      { from: 'client', to: 'orch', tone: 'brand', rate: 1.2 },
      { from: 'orch', to: 'inv', tone: 'ok', rate: 1.2 },
      { from: 'orch', to: 'pay', tone: 'ok', rate: 1.2 },
      { from: 'orch', to: 'ship', tone: 'danger', rate: 1.2, outcome: 'failure' },
    ],
    steps: [
      { from: 'client', to: 'orch', label: 'Order saved as PENDING' },
      { from: 'orch', to: 'inv', label: 'Step 2: stock reserved' },
      { from: 'orch', to: 'pay', label: 'Step 3: card charged' },
      { from: 'orch', to: 'ship', label: 'Step 4 fails: bad address', outcome: 'failure' },
      { from: 'orch', to: 'pay', label: 'Compensate 3: refund', outcome: 'warning' },
      { from: 'orch', to: 'inv', label: 'Compensate 2: release stock', outcome: 'warning' },
      { from: 'orch', to: 'client', label: 'Compensate 1: order rejected', outcome: 'warning' },
    ],
  },

  'outbox-pattern': {
    width: 860,
    height: 280,
    caption: 'One transaction writes both rows, so no event is lost or invented. The relay publishes at least once.',
    nodes: [
      { id: 'app', kind: 'service', label: 'Order service', sub: 'one transaction', x: 30, y: 98, w: 170, h: 84 },
      { id: 'db', kind: 'sql', label: 'orders + outbox', sub: 'committed together', x: 250, y: 94, w: 190, h: 92 },
      { id: 'relay', kind: 'worker', label: 'Relay', sub: 'polls unsent rows', x: 490, y: 15, w: 160, h: 74 },
      { id: 'broker', kind: 'queue', label: 'Kafka', sub: 'order-events', x: 490, y: 190, w: 160, h: 74 },
      { id: 'consumer', kind: 'worker', label: 'Fulfilment', sub: 'dedupes by event id', x: 689, y: 190, w: 162, h: 74 },
    ],
    edges: [
      { from: 'app', to: 'db', tone: 'brand', rate: 2 },
      { from: 'db', to: 'relay', tone: 'ok', rate: 1.6 },
      { from: 'relay', to: 'broker', tone: 'warn', rate: 1.6 },
      { from: 'broker', to: 'consumer', tone: 'brand', rate: 1.6 },
    ],
    steps: [
      { from: 'app', to: 'db', label: 'Order row plus outbox row' },
      { from: 'app', to: 'db', label: 'Crash before COMMIT: both roll back', outcome: 'failure' },
      { from: 'db', to: 'relay', label: 'Relay reads unsent rows' },
      { from: 'relay', to: 'broker', label: 'Published, at least once' },
      { from: 'relay', to: 'db', label: 'Row marked as sent' },
      { from: 'broker', to: 'consumer', label: 'Repeated event id is skipped', outcome: 'cache-hit' },
    ],
  },

  'leader-follower': {
    width: 760,
    height: 280,
    caption: 'One node orders the writes; the rest copy that order and serve reads.',
    nodes: [
      { id: 'w', kind: 'client', label: 'Writes', x: 40, y: 22, w: 140, h: 74 },
      { id: 'leader', kind: 'sql', label: 'Leader', x: 260, y: 17, w: 160, h: 84 },
      { id: 'f1', kind: 'sql', label: 'Follower 1', x: 530, y: 20, w: 170, h: 78 },
      { id: 'f2', kind: 'sql', label: 'Follower 2', x: 530, y: 185, w: 170, h: 78 },
      { id: 'r', kind: 'client', label: 'Reads', x: 260, y: 187, w: 140, h: 74 },
    ],
    edges: [
      { from: 'w', to: 'leader', tone: 'brand', rate: 2 },
      { from: 'leader', to: 'f1', tone: 'violet', rate: 1.6, outcome: 'warning' },
      { from: 'leader', to: 'f2', tone: 'violet', rate: 1.6, outcome: 'warning' },
      { from: 'r', to: 'f1', tone: 'ok', rate: 1.6, outcome: 'cache-hit' },
      { from: 'r', to: 'f2', tone: 'ok', rate: 1.6, outcome: 'cache-hit' },
    ],
    steps: [
      { from: 'w', to: 'leader', label: 'Every write goes to leader' },
      { from: 'leader', to: 'f1', label: 'Leader orders it, streams it' },
      { from: 'leader', to: 'f2', label: 'Every follower copies that order' },
      { from: 'r', to: 'f1', label: 'Reads spread over followers' },
      { from: 'f2', to: 'r', label: 'A follower may answer stale', outcome: 'warning' },
    ],
  },

  'producer-consumer': {
    width: 760,
    height: 280,
    caption: 'The buffer decouples the rates; consumption must still match production on average.',
    nodes: [
      { id: 'p', kind: 'server', label: 'Producers', x: 40, y: 95, w: 160, h: 80 },
      { id: 'buf', kind: 'queue', label: 'Bounded buffer', x: 280, y: 90, w: 180, h: 88 },
      { id: 'c', kind: 'worker', label: 'Consumers', x: 550, y: 95, w: 170, h: 80 },
    ],
    edges: [
      { from: 'p', to: 'buf', tone: 'brand', rate: 3 },
      { from: 'buf', to: 'c', tone: 'ok', rate: 3 },
    ],
    steps: [
      { from: 'p', to: 'buf', label: 'Producer puts an item' },
      { from: 'buf', to: 'c', label: 'Exactly one consumer takes it' },
      { from: 'p', to: 'buf', label: 'Burst waits in the buffer', outcome: 'warning' },
      { from: 'buf', to: 'c', label: 'Consumers drain at own pace' },
    ],
  },

  'request-response': {
    width: 760,
    height: 270,
    caption: 'Four hops at 99.9% each: together about 99.6%, and the latencies add.',
    nodes: [
      { id: 'a', kind: 'service', label: 'A', sub: '99.9%', x: 40, y: 95, w: 130, h: 80 },
      { id: 'b', kind: 'service', label: 'B', sub: '99.9%', x: 230, y: 95, w: 130, h: 80 },
      { id: 'c', kind: 'service', label: 'C', sub: '99.9%', x: 420, y: 95, w: 130, h: 80 },
      { id: 'd', kind: 'sql', label: 'D', sub: '99.9%', x: 600, y: 95, w: 140, h: 80 },
    ],
    edges: [
      { from: 'a', to: 'b', tone: 'brand', rate: 2.4 },
      { from: 'b', to: 'c', tone: 'brand', rate: 2.4 },
      { from: 'c', to: 'd', tone: 'warn', rate: 2.4, outcome: 'warning' },
    ],
    steps: [
      { from: 'a', to: 'b', label: 'A calls B, then waits' },
      { from: 'b', to: 'c', label: 'B calls C, also waiting' },
      { from: 'c', to: 'd', label: 'C calls D: waits stack up', outcome: 'warning' },
      { from: 'd', to: 'c', label: 'Responses unwind hop by hop' },
      { from: 'b', to: 'a', label: 'A answers only if all succeed' },
    ],
  },
};
