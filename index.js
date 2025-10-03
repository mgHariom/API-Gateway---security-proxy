const http = require('http');
const {port, routes, JWT_SECRET} = require('./config');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// global variables for rate limit
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const requestCounts = new Map();

//state management for Resilience
const CIRCUIT_CONFIG = {
    FAILURE_THRESHOLD: 3,
    RESET_TIMEOUT_MS: 5000,
};

const circuitState = {
    status: 'CLOSED',
    failureCount: 0,
    lastFailureTime: 0
}

function rateLimit(req, targetConfig) {
    //Check if rate limit is enabled for this route
    if (!targetConfig.limit) {
        return {allowed: true, remaining: -1, resetTime: 0};
    }

    //Identify client IP
    //check for constant proxy headrers first, otherwise fall back to the direct remote address.
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const now = Date.now();
    const clientData = requestCounts.get(clientIP);

    if(clientData && clientData.windowStart + RATE_LIMIT_WINDOW_MS > now) {
        if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
            return {
                allowed: false,
                remaining: 0,
                resetTime: clientData.windowStart+ RATE_LIMIT_WINDOW_MS
            };
        } else {
            clientData.count++;
            requestCounts.set(clientIP, clientData);
        }
    } else {
        requestCounts.set(clientIP, {
            count: 1,
            windowStart: now
        });
    }

    const remaining = RATE_LIMIT_MAX_REQUESTS - requestCounts.get(clientIP).count;
    const resetTime = requestCounts.get(clientIP).wondowstart + RATE_LIMIT_WINDOW_MS;

    return {allowed: true, remaining: remaining, resetTime: resetTime}; 
}

function getTarget(reqUrl) {
    var prefixes = Object.keys(routes);

    let bestMatch = null;

    for (const prefix of prefixes) {
        console.log(`${requestId} [Debug] checking prefix: ${prefix}`)

        if (reqUrl.startsWith(prefix) && (!bestMatch || prefix.length > bestMatch.prefix.length)) {

            console.log(`${requestId} [Debug] checking prefix: ${prefix}`)
            bestMatch = {prefix , config: routes[prefix]};
        }
    }

    if (bestMatch) {
        const parsedTarget = new URL(bestMatch.config.target);
        const newPathRaw = reqUrl.substring(bestMatch.prefix.length); 

        // Ensure the newPath is always prefixed with a slash, 
        // correctly handling cases with just query params.
        const newPath = newPathRaw.startsWith('?') || newPathRaw === '' ? 
            '/' + newPathRaw : 
            newPathRaw;

        console.log(`${requestId} [Debug] Final target: ${bestMatch.config.target}`);    

        return {
            target: parsedTarget,
            newPath: newPath || '/',
            config: bestMatch.config
        };
    }
    console.log('${requestId} [Router Debug] No route match found. Returning 404.');
    return null;
}

// AUTHENTICATION LOGIC

function isAuthenticated(req, targetConfig) {
    //Check if route requires authentication
    if (targetConfig && targetConfig.auth === false) {
        return {authorized: true, reason: "Route does not require authentication"}; //no auth required for this route
    }

    //Extract token from authorization header
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return {authorized: false, reason: 'Missing authorization header'};
    }

    const token = authHeader.split(' ')[1];

    //verify token signature and expiration 
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        //Attach the user payload to the request for logging or later use
        req.user = decoded;
        return {authorized: true};    
    } catch (err) {
        return {authorized: false, reason: 'Invalid or expired token'};
    }
}

const server = http.createServer((req, res) => {

    //logging 
    const startTime = Date.now();

    // Generate a unique request ID
    const requestId = req.headers['x-request-id'] || uuidv4();

    //set the ID on the response header
    res.setHeader('X-Request-Id', requestId);

    //Propgate the id to the backend
    proxyHeaders['X-Request-Id'] = requestId;

    // 1. Get the URL, trim simple whitespace
    let cleanReqUrl = req.url.trim(); 
    
    // 2. Ensure the URL starts with a single '/'
    if (!cleanReqUrl.startsWith('/')) {
        // If it was just a space or junk, prepend the slash
        cleanReqUrl = '/' + cleanReqUrl; 
    }
    
    // 3. Remove multiple leading slashes that might have resulted
    cleanReqUrl = cleanReqUrl.replace(/^\/\/+/, '/'); 
    
    console.log(`${requestId} [Gateway] Received request: ${req.method} ${cleanReqUrl}`);
    // Routing 
    const targetInfo = getTarget(cleanReqUrl);
    console.log(`${requestId} [debug] tagetInfo: ${targetInfo}`)

    if (!targetInfo) {
        res.writeHead(404, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({error: 'Route not found'}));
    }

    //POLICY ENFORCEMENT: AUTHENTICATION
    const authResult = isAuthenticated(req, targetInfo.config);

    if (!authResult.authorized) {
        console.warn(`${requestId} [Security] UNAUTHORIZED access to ${req.url}. Reason: ${authResult.reason}`);
        res.writeHead(401, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({error: 'Unauthorized', message: authResult.reason}));
    }
    //if authorized, the code continues to the prozy step!

    //POLICY ENFORCEMENT: RATE LIMITING 
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const limitResult = rateLimit(req, targetInfo.config);

    //set standard rate limit headers
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS);
    res.setHeader('X-RateLimit-Remaining', limitResult.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(limitResult.resetTime / 1000));

    if (!limitResult.allowed) {
        console.warn(`${requestId} [Security] RATE LIMIT EXCEEDED for ${clientIP} `);
        res.writeHead(429, {'content-type': 'application/json'});
        return res.end(JSON.stringify({error: 'Too many Requests', message: 'Rate limit exceeded. Try again later.'}));
    }

    //Circuit breaking before proxying
    if (targetInfo.config.limit && circuitState.status === 'OPEN') {
        const now = Date.now();
        if (now > circuitState.lastFailureTime + CIRCUIT_CONFIG.RESET_TIMEOUT_MS) {
            //time to try again - move to HALF_OPEN
            circuitState.status = 'HALF-OPEN';
            console.warn(`[Circuit Breaker] Moving to HALF-OPEN for service 1.`);
        } else {
            //Circuit is OPEN - fail fast 
            console.error(`[Circuit Breaker] OPEN. Failing fast for ${req.url}`);
            res.writeHead(503, {'content-type': 'application/json'});
            return res.end(JSON.stringify({error: 'Service Unavailable', message: 'circuit breaker is open'}));
        }
    }

    //Preparing forward request 
    const {target, newPath} = targetInfo;

    //Options for teh new request that we will make to the backend service 
    const proxtOptions = {
        hostname: target.hostname,
        port: target.port,
        path: newPath, // the stripped path (e.g. /item/10) if path is (http://localhost:8080/products/item/10)
        method: req.method, //pass the original HTTP method 
        headers: req.headers, //pass all original client headers
    };

    //The core proxing (streams)

    //Create req to backend service 
    const proxyReq = http.request(proxtOptions, (proxyRes) => {
        // Send Headers: once backend responds transfer its statuscode and headers 
        res.writeHead(proxyRes.statusCode, proxyRes.headers);

        // Stream Body: pipe the backend response stream directly to the clients response stream
        //non-blocking and effective 
        proxyRes.pipe(res, {end: true});
        });

        //Stream body: Pipe the clients incoming request stream 
        req.pipe(proxyReq, {end: true});

        proxyReq.on('close', () => {
            //simple structured log example
            const latency = Date.now() - startTime
            const logData = {
                requestId: requestId,
                method: req.method,
                url: cleanReqUrl,
                status: req.statusCode,
                latency_ms: latency,
                clientIP: clientIP,
                user_id: req.user ? req.user.sub : 'anonymous',
            }

            console.log(JSON.stringify(logData))

        })

        //Error handling 
        proxyReq.on('error', (err) => {
            console.log(`${requestId} [Proxy Error] Cannot reach the backend ${target.href}: ${err.message}`);
            res.writeHead(502, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: 'Bad Gateway: backend servoce unavailable'}));

            circuitState.failureCount++;
            circuitState.lastFailureTime = Date.now();
            if (circuitState.failureCount >= CIRCUIT_CONFIG.FAILURE_THRESHOLD && circuitState.status === 'CLOSED'){
                circuitState.status = 'OPEN';
                console.error(`[Circuit Breaker] TRIP! Service failed ${circuitState.failureCount} times. Status: OPEN.`)
            }
    });
});



server.listen(port, (error) => {
    console.log(`Advanced API Gateway running on http://localhost:${port}`);
    console.log('Routes loaded:', Object.keys(routes).join(','));
})