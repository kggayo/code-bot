#!/usr/bin/env node
'use strict';

// The `code-bot` command (src/headless/cli.ts). Plain old JavaScript on purpose:
// an older Node gets a clear message here instead of a syntax error from the
// TypeScript files, which Node 24 runs directly (types stripped).

var major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error('code-bot needs Node 24 or newer; this is Node ' + process.version + ' (' + process.execPath + ').');
  process.exit(1);
}

// node:sqlite still prints an experimental warning at every start in Node 24; it means nothing to the user.
var emitWarning = process.emitWarning;
process.emitWarning = function (warning) {
  var rest = Array.prototype.slice.call(arguments, 1);
  var type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
  if (type === 'ExperimentalWarning' && /SQLite/.test(String(warning && warning.message ? warning.message : warning))) return;
  return emitWarning.apply(process, arguments);
};

var path = require('path');
var url = require('url');
// Through Function so that an old Node never has to parse import().
var load = new Function('specifier', 'return import(specifier)');

function finish(code) {
  process.exitCode = code;
  // Leave once output is written; something left open (a stdin listener) must not keep the command alive.
  setTimeout(function () {
    process.exit(code);
  }, 500).unref();
}

load(url.pathToFileURL(path.join(__dirname, '..', 'src', 'headless', 'cli.ts')).href)
  .then(function (cli) {
    return cli.main(process.argv.slice(2));
  })
  .then(finish, function (error) {
    console.error(error && error.stack ? error.stack : String(error));
    finish(1);
  });
