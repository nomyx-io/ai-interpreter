const axios = require('axios');
module.exports = {
    schema: {
        type: 'function',
        function: {
            name: 'callAPI',
            description: 'make an API call at the given url using the given request method with given request params and return the response',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The URL to call.'
                    },
                    method: {
                        type: 'string',
                        description: 'The HTTP method to use.'
                    },
                    request_params: {
                        type: 'object',
                        description: 'The request parameters to send.',
                        additionalProperties: true
                    }
                },
                required: ['url', 'method']
            }
        },
    },
    function: async ({ url, method, request_params = {} }) => {
        try {
            const response = await axios({ method, url, data: request_params });
            return JSON.stringify(response.data);
        } catch (error) {
            return `Error calling ${url}: ${error.message}`
        }
    }
};

