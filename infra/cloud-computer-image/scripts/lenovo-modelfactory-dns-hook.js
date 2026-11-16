// Force Lenovo Aimaster / ModelFactory hostnames to intranet IPs when
// /etc/hosts is read-only (Cube/Multica sandboxes mount tmpfs RO over /etc/hosts).
'use strict';

const dns = require('node:dns');

const HOST_MAP = Object.freeze({
  'braimaster.lenovo.com': '10.46.124.101',
  'modelfactory.lenovo.com': '10.110.158.101',
});

function mappedAddress(hostname) {
  if (!hostname) return null;
  return HOST_MAP[String(hostname).toLowerCase()] || null;
}

const originalLookup = dns.lookup.bind(dns);
dns.lookup = function lenovoModelFactoryLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  const mapped = mappedAddress(hostname);
  if (!mapped) {
    return originalLookup(hostname, options, callback);
  }

  const opts = typeof options === 'object' && options !== null ? options : {};
  const family = opts.family === 6 ? 6 : 4;
  if (family === 6) {
    const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
      code: 'ENOTFOUND',
      hostname,
    });
    if (typeof callback === 'function') {
      process.nextTick(() => callback(err));
      return undefined;
    }
    throw err;
  }

  if (opts.all) {
    const result = [{ address: mapped, family: 4 }];
    if (typeof callback === 'function') {
      process.nextTick(() => callback(null, result));
      return undefined;
    }
    return result;
  }

  if (typeof callback === 'function') {
    process.nextTick(() => callback(null, mapped, 4));
    return undefined;
  }
  return mapped;
};

if (typeof dns.promises?.lookup === 'function') {
  dns.promises.lookup = function lenovoModelFactoryLookupPromise(hostname, options) {
    return new Promise((resolve, reject) => {
      dns.lookup(hostname, options, (err, address, family) => {
        if (err) {
          reject(err);
          return;
        }
        if (options && typeof options === 'object' && options.all) {
          resolve(address);
          return;
        }
        resolve({ address, family });
      });
    });
  };
}
