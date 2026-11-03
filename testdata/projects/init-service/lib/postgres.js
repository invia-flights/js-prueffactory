'use strict';

const net = require('node:net');

// One simple query over the PostgreSQL wire protocol, with no dependencies.
// The server is the compose service postgres, which accepts every connection
// (POSTGRES_HOST_AUTH_METHOD=trust). It resolves to the rows of the reply,
// each a list of strings, and rejects with the server's own message.
function query(sql) {
  const url = new URL(process.env.DATABASE_URL);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) || 5432 });
    const rows = [];
    let failure = null;
    let queried = false;
    let finished = false;
    let pending = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('close', () => {
      if (failure) reject(failure);
      else if (!finished) reject(new Error('the connection closed early'));
      else resolve(rows);
    });
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const length = pending.readInt32BE(1);
        if (pending.length < 1 + length) return;
        const type = String.fromCharCode(pending[0]);
        const body = pending.subarray(5, 1 + length);
        pending = pending.subarray(1 + length);
        if (type === 'E') {
          failure = new Error(errorMessage(body));
        } else if (type === 'D') {
          rows.push(dataRow(body));
        } else if (type === 'Z' && !queried) {
          queried = true;
          socket.write(message('Q', Buffer.from(sql + '\0')));
        } else if (type === 'Z') {
          finished = true;
          socket.end(message('X', Buffer.alloc(0)));
        }
      }
    });
    const parameters = Buffer.from(`user\0${url.username}\0database\0${url.pathname.slice(1)}\0\0`);
    const startup = Buffer.alloc(8 + parameters.length);
    startup.writeInt32BE(startup.length, 0);
    startup.writeInt32BE(196608, 4);
    parameters.copy(startup, 8);
    socket.write(startup);
  });
}

function message(type, body) {
  const head = Buffer.alloc(5);
  head.write(type, 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

// errorMessage is the human readable message ('M') of an ErrorResponse.
function errorMessage(body) {
  let at = 0;
  while (at < body.length && body[at] !== 0) {
    const end = body.indexOf(0, at + 1);
    if (String.fromCharCode(body[at]) === 'M') return body.toString('utf8', at + 1, end);
    at = end + 1;
  }
  return 'the server reported an error';
}

function dataRow(body) {
  const row = [];
  let at = 2;
  for (let i = 0; i < body.readInt16BE(0); i++) {
    const length = body.readInt32BE(at);
    at += 4;
    row.push(length < 0 ? null : body.toString('utf8', at, at + length));
    at += Math.max(length, 0);
  }
  return row;
}

module.exports = { query };
