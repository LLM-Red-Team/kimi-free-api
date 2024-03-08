import { PassThrough } from "stream";
import _ from 'lodash';
import axios, { AxiosResponse } from 'axios';

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import { createParser } from 'eventsource-parser'
import logger from '@/lib/logger.ts';
import util from '@/lib/util.ts';

const ACCESS_TOKEN_EXPIRES = 300;
const accessTokenMap = new Map();

async function requestToken(refreshToken: string) {
  const result = await axios.get('https://kimi.moonshot.cn/api/auth/token/refresh', {
    headers: {
      Authorization: `Bearer ${refreshToken}`
    },
    validateStatus: () => true
  });
  const {
    access_token,
    refresh_token
  } = checkResult(result, refreshToken);
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    refreshTime: util.unixTimestamp() + ACCESS_TOKEN_EXPIRES
  }
}

async function acquireToken(refreshToken: string): Promise<string> {
  let result = accessTokenMap.get(refreshToken);
  if (!result) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  }
  if (util.unixTimestamp() > result.refreshTime)
    result = await requestToken(refreshToken);
  return result.accessToken;
}

async function createConversation(name: string, refreshToken: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.post('https://kimi.moonshot.cn/api/chat', {
    name,
    is_example: false
  }, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    validateStatus: () => true
  });
  const {
    id: convId
  } = checkResult(result, refreshToken);
  return convId;
}

async function removeConversation(convId: string, refreshToken: string) {
  const token = await acquireToken(refreshToken);
  const result = await axios.delete(`https://kimi.moonshot.cn/api/chat/${convId}`, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    validateStatus: () => true
  });
  checkResult(result, refreshToken);
}

async function createCompletion(messages: any[], refreshToken: string, useSearch = true) {
  logger.info(messages);
  const convId = await createConversation(`cmpl-${util.uuid(false)}`, refreshToken);
  const token = await acquireToken(refreshToken);
  const result = await axios.post(`https://kimi.moonshot.cn/api/chat/${convId}/completion/stream`, {
    messages,
    use_search: useSearch
  }, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    validateStatus: () => true,
    responseType: 'stream'
  });
  const answer = await receiveStream(convId, result.data);
  removeConversation(convId, refreshToken)
      .catch(err => console.error(err));
  return answer;
}

async function createCompletionStream(messages: any[], refreshToken: string, useSearch = true) {
  logger.info(messages);
  const convId = await createConversation(`cmpl-${util.uuid(false)}`, refreshToken);
  const token = await acquireToken(refreshToken);
  const result = await axios.post(`https://kimi.moonshot.cn/api/chat/${convId}/completion/stream`, {
    messages,
    use_search: useSearch
  }, {
    headers: {
      Authorization: `Bearer ${token}`
    },
    validateStatus: () => true,
    responseType: 'stream'
  });
  return createTransStream(convId, result.data, () => {
    removeConversation(convId, refreshToken)
      .catch(err => console.error(err));
  });
}

function checkResult(result: AxiosResponse, refreshToken: string) {
  if(result.status == 401) {
    accessTokenMap.delete(refreshToken);
    throw new APIException(EX.API_REQUEST_FAILED);
  }
  if (!result.data)
    return null;
  const { error_type, message } = result.data;
  if (!_.isString(error_type))
    return result.data;
  if (error_type == 'auth.token.invalid')
    accessTokenMap.delete(refreshToken);
  throw new APIException(EX.API_REQUEST_FAILED, `[请求kimi失败]: ${message}`);
}

async function receiveStream(convId: string, stream: any) {
  return new Promise((resolve, reject) => {
    const data = {
      id: convId,
      model: 'kimi',
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }
      ],
      created: parseInt(performance.now() as any)
    };
    const parser = createParser(event => {
      try {
        if (event.type !== "event") return;
        const result = _.attempt(() => JSON.parse(event.data));
        if (_.isError(result))
          throw new Error(`stream response invalid: ${event.data}`);
        if (result.event == 'cmpl') {
          data.choices[0].message.content += result.text;
        }
        else if (result.event == 'all_done')
          resolve(data);
      }
      catch (err) {
        logger.error(err);
        reject(err);
      }
    });
    stream.on("data", buffer => parser.feed(buffer.toString()));
    stream.once("error", err => reject(err));
    stream.once("close", () => resolve(data));
  });
}

function createTransStream(convId: string, stream: any, endCallback?: Function) {
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
        !transStream.closed && transStream.end('data: [DONE]\n\n');
        endCallback && endCallback();
      }
    }
    catch (err) {
      logger.error(err);
      !transStream.closed && transStream.end('\n\n');
    }
  });
  stream.on("data", buffer => parser.feed(buffer.toString()));
  stream.once("error", () => !transStream.closed && transStream.end('data: [DONE]\n\n'));
  stream.once("close", () => !transStream.closed && transStream.end('data: [DONE]\n\n'));
  return transStream;
}

export default {
  createConversation,
  createCompletion,
  createCompletionStream
};
