// Route configuration map

const routes = {
    '/service1': {
        'target': 'http://localhost:3001',
        'auth': true,
        'limit': true
    },
    '/products': {
        'target': 'http://localhost:3002',
        'auth': false,
        "limit": true,
    },
    '/': {
        'target': 'http://localhost:9999',
        'auth': false,
        'limit': true,
    }
};


const JWT_SECRET = "da08ed54784f6667"

module.exports = {
    port: 8080,
    routes,
    JWT_SECRET,
};