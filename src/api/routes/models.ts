import _ from 'lodash';

export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "moonshot-v1",
                        "object": "model",
                        "owned_by": "kimi-free-api"
                    },
                    {
                        "id": "moonshot-v1-8k",
                        "object": "model",
                        "owned_by": "kimi-free-api"
                    },
                    {
                        "id": "moonshot-v1-32k",
                        "object": "model",
                        "owned_by": "kimi-free-api"
                    },
                    {
                        "id": "moonshot-v1-128k",
                        "object": "model",
                        "owned_by": "kimi-free-api"
                    },
                    {
                        "id": "moonshot-v1-vision",
                        "object": "model",
                        "owned_by": "kimi-free-api"
                    }
                ]
            };
        }

    }
}