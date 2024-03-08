import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import Response from '@/lib/response/Response.ts';
import chat from '@/api/controllers/chat.ts';
import logger from '@/lib/logger.ts';

export default {

    prefix: '/v1/chat',

    post: {

        '/completions': async (request: Request) => {
            request
                .validate('body.messages', _.isArray)
                .validate('headers.authorization', _.isString)
            const token = request.headers.authorization;
            const refreshToken = token.replace('Bearer ', '');
            logger.info(`Refresh token: ${refreshToken}`);
            const messages =  request.body.messages;
            if (request.body.stream) {
                const stream = await chat.createCompletionStream(request.body.messages, refreshToken, request.body.use_search);
                return new Response(stream, {
                    type: "text/event-stream"
                });
            }
            else
                return await chat.createCompletion(messages, refreshToken, request.body.use_search);
        }

    }

}