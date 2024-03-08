import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';

export default {
    
    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.messages', _.isArray)
            chat.setRefreshToken(request.body.refresh_token);
            const stream = await chat.createCompletionStream(request.body.messages, request.body.use_search);
            return new Response(stream, {
                type: "text/event-stream"
            });
        }

    }

}