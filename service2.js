const http = require('http');

const server = http.createServer((req, res) => {
    console.log(`[Service2 - 3002] Received ${req.method} request for path: ${req.url}`);

    //standard successful response header
    res.writeHead(200, {'Content-Type': 'application/json'});

    //Respond with a Json object
    const responseData = {
        service: 'Service 2 (product catalog)',
        status: 'OK',
        path_receives_by_backend: req.url,
        query_paramas: new URL(`http://localhost${req.url}`)
    };

    res.end(JSON.stringify(responseData));
});

const PORT = 3002;
server.listen(PORT, () => {
    console.log(`[Service 2] Running on http://localhost:${PORT}`)
})