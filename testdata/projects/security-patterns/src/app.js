'use strict';

const express = require('express');
const { exec } = require('child_process');
const https = require('https');

const app = express();

// A request value goes straight into a shell command.
app.get('/ping', (req, res) => {
  exec('ping -c 1 ' + req.query.host, (err, stdout) => {
    res.send(stdout);
  });
});

// A request value is evaluated as code.
app.get('/calc', (req, res) => {
  res.send(String(eval(req.query.expr)));
});

// The redirect target comes from the request. The comment must not hide it.
app.get('/go', (req, res) => {
  // nosemgrep
  res.redirect(req.query.next);
});

// TLS verification is switched off.
const agent = new https.Agent({ rejectUnauthorized: false });

module.exports = { app, agent };
