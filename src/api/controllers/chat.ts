import { PassThrough } from "stream";
import _ from 'lodash';
import axios, { AxiosResponse } from 'axios';

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from 'eventsource-parser'
import logger from '@/lib/logger.ts';
import util from '@/lib/util.ts';

const TOKEN_EXPIRES = 120;
let currentAccessToken: string | null = null;
let currentRefreshToken: string | null = null;
let latestRefreshTime = 0;

function setRefreshToken(refreshToken: string) {
  currentRefreshToken = refreshToken || 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ1c2VyLWNlbnRlciIsImV4cCI6MTcxNzY2NzkzMSwiaWF0IjoxNzA5ODkxOTMxLCJqdGkiOiJjbmxlMm1wcmRpamFpbGxzcHJuMCIsInR5cCI6InJlZnJlc2giLCJzdWIiOiJjbmVyMGgybG5sOTU3N3MzMmluZyIsInNwYWNlX2lkIjoiY25lcXA1ODNyMDdkajd1a3JqcjAiLCJhYnN0cmFjdF91c2VyX2lkIjoiY25lcXA1ODNyMDdkajd1a3JqcWcifQ.XMDecAmBq817_n3xtRqIwIlS9QQLIClS1PaVh4EY8bqhiHr8SxFxbiTEyuRuPPTnCB90eUJNc_LchLMjUo8cKA';
}

async function refreshToken() {
  const refreshToken = currentRefreshToken;
  const result = await axios.get('https://kimi.moonshot.cn/api/auth/token/refresh', {
    headers: {
      Authorization: `Bearer ${refreshToken}`
    }
  });
  const {
    access_token,
    refresh_token
  } = checkResult(result);
  currentAccessToken = access_token;
  currentRefreshToken = refresh_token;
  logger.info(`Current access_token: ${currentAccessToken}`);
  logger.info(`Current refresh_token: ${currentRefreshToken}`);
  logger.success('Token refresh completed');
}

async function requestToken() {
  if (util.unixTimestamp() - latestRefreshTime > TOKEN_EXPIRES)
    await refreshToken();
  return currentAccessToken;
}

async function createConversation(name: string) {
  const token = await requestToken();
  const result = await axios.post('https://kimi.moonshot.cn/api/chat', {
    name,
    is_example: false
  }, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const {
    id: convId
  } = checkResult(result);
  return convId;
}

async function removeConversation(convId: string) {
  const token = await requestToken();
  const result = await axios.delete(`https://kimi.moonshot.cn/api/chat/${convId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  checkResult(result);
}

async function createCompletionStream(messages: any[], useSearch = true) {
  console.log(messages);
  const convId = await createConversation(`cmpl-${util.uuid(false)}`);
  const token = await requestToken();
  const result = await axios.post(`https://kimi.moonshot.cn/api/chat/${convId}/completion/stream`, {
    messages,
    use_search: useSearch
  }, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    responseType: 'stream'
  });
  return createTransStream(convId, result.data);
}

function checkResult(result: AxiosResponse) {
  if(!result.data)
    return null;
  const { error_type, message } = result.data;
  if (!_.isString(error_type))
    return result.data;
  console.log(result.data);
  throw new APIException(EX.API_REQUEST_FAILED, message);
}

function createTransStream(convId: string, stream: any) {
  const created = parseInt(performance.now() as any);
  const transStream = new PassThrough();

  !transStream.closed && transStream.write(`data: ${JSON.stringify({
    id: convId,
    model: 'kimi',
    object: 'chat.completion.chunk',
    choices: [
      { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }
    ],
    created
  })}\n\n`);
  const parser = createParser(event => {
    try {
      if (event.type !== "event") return;
      const result = _.attempt(() => JSON.parse(event.data));
      if (_.isError(result))
        throw new Error(`stream response invalid: ${event.data}`);
      if (result.event == 'cmpl') {
        const data = `data: ${JSON.stringify({
          id: convId,
          model: 'kimi',
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { content: result.text }, finish_reason: null }
          ],
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
      }
      else if (result.event == 'all_done') {
        const data = `data: ${JSON.stringify({
          id: convId,
          model: 'kimi',
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: {}, finish_reason: 'stop' }
          ],
          created
        })}\n\n`;
        !transStream.closed && transStream.write(data);
        !transStream.closed && transStream.end('[DONE]');
        removeConversation(convId).catch(err => console.error(err));
      }
    }
    catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end('\n\n');
    }
  });
  stream.on("data", buffer => parser.feed(buffer.toString()));
  stream.once("error", () => !transStream.closed && transStream.end('[DONE]'));
  stream.once("close", () => !transStream.closed && transStream.end('[DONE]'));
  return transStream;
}

export default {
  setRefreshToken,
  refreshToken,
  createConversation,
  createCompletionStream
};
