const http = require('http');

const server = http.createServer((req, res) => {
    console.log(`[Service1 - 3001] Received ${req.method} request for path: ${req.url}`);

    //standard successful response header
    res.writeHead(200, {'Content-Type': 'application/json'});

    //Respond with a Json object
    const responseData = {
        service: 'Service 1 (user management)',
        status: 'OK',
        path_receives_by_backend: req.url,
        method: req.method
    };

    res.end(JSON.stringify(responseData));
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`[Service 1] Running on http://localhost:${PORT}`)
})