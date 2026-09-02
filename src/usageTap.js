'use strict';

const diagnostics = require('diagnostics_channel');
const { parseOAuthUsage } = require('./quota');

const MAX_RESPONSE_BYTES = 1024 * 1024;

function installUsageTap(onUsage) {
  const pending = new WeakSet();

  const requestHandler = message => {
    try {
      const request = message?.request;
      const requestPath = request?.path;
      const host = request?.getHeader?.('host');
      if (typeof requestPath === 'string' && requestPath.includes('/api/oauth/usage') && typeof host === 'string' && /(^|\.)anthropic\.com(?::\d+)?$/i.test(host)) {
        pending.add(request);
      }
    } catch { /* never interfere with another extension */ }
  };

  const responseHandler = message => {
    try {
      if (!pending.has(message?.request)) return;
      pending.delete(message.request);
      if (message.response?.statusCode === 200) tapResponse(message.response, onUsage);
    } catch { /* never interfere with another extension */ }
  };

  diagnostics.subscribe('http.client.request.start', requestHandler);
  diagnostics.subscribe('http.client.response.finish', responseHandler);
  return {
    dispose() {
      diagnostics.unsubscribe('http.client.request.start', requestHandler);
      diagnostics.unsubscribe('http.client.response.finish', responseHandler);
    }
  };
}

function tapResponse(response, onUsage) {
  let body = '';
  const originalOn = response.on.bind(response);
  response.on = function (event, listener) {
    if (event === 'data') {
      return originalOn(event, function (chunk) {
        if (body.length < MAX_RESPONSE_BYTES) body += chunk.toString().slice(0, MAX_RESPONSE_BYTES - body.length);
        return listener.apply(this, arguments);
      });
    }
    if (event === 'end') {
      return originalOn(event, function () {
        try { if (body) onUsage(parseOAuthUsage(JSON.parse(body))); } catch { /* malformed or changed upstream response */ }
        return listener.apply(this, arguments);
      });
    }
    return originalOn(event, listener);
  };
}

module.exports = { installUsageTap, tapResponse };
