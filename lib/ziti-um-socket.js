/*
Copyright 2019-2020 Netfoundry, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const { Duplex } = require('stream').Duplex;
// const { Readable } = require('stream').Readable;
const logger = require('electron-log');
const EventEmitter = require('events');
import { v4 as uuidv4 } from 'uuid';

export class ZitiSocket extends Duplex {
  constructor(ziti, opts) {
    super();

    this.ziti = ziti; // the Ziti native addon (a.k.a. ziti-sdk-nodejs)
    logger.debug('ZitiSocket.ctor entered, this.ziti: %o', this.ziti);

    this.opts = opts;

    /**
     * This stream is where we'll put any data returned from a Ziti connection (see ziti_dial.data.call_back)
     */
    // this.readableZitiStream = new Readable();
    // this.readableZitiStream._read = function() {};

    this.uuid = uuidv4();   // debugging/tracing aid
    // this.readableZitiStream.uuid = uuidv4();   // debugging/tracing aid

    /**
     * The underlying Ziti Connection
     * @private
     * @type {string}
     */
    this.zitiWebsocket = null;

    /**
     * Start the async iterator on the Ziti stream.
     */
    // setImmediate(this._pumpReadableZitiStream.bind(this));

    EventEmitter.call(this);
  }

  /**
   * Write data onto the underlying Ziti connection by invoking the ziti_websocket_write() function in the Ziti NodeJS-SDK.  The
   * NodeJS-SDK expects incoming data to be of type Buffer.
   */
  ziti_websocket_write(conn, buffer) {
    const self = this;
    return new Promise((resolve) => {
      self.ziti.ziti_websocket_write(conn, buffer, (obj) => {
        resolve(obj);
      });
    });
  }

  /**
   * Perform ...
   *
   * @return  Promise
   */
  async _get_ziti_websocket(url, headersArray) {
    const self = this;

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
      logger.info('get_ziti_websocket entered, url is: [%o], headersArray is: %o', url, headersArray);

      const rc = self.ziti.ziti_websocket_connect(
        url,
        headersArray,

        /**
         * on_connect callback.
         */
        (ws) => {
          if (typeof ws === 'undefined') {
            logger.error('on_connect callback: CANNOT GET CONNECTION');
          } else {
            logger.info('on_connect callback: ws: %s', this.connAsHex(ws));
          }
          resolve(ws);
        },

        /**
         * on_data callback (we receive a Buffer containing uint8_t's from the NodeJS SDK)
         */
        (obj) => {
          logger.info('ZitiSocket on_data <--- obj: %o', obj);
          if (obj.len > 0) {
            self.push(obj.data);
          } else {
            self.emit('error', new Error('on_data length error: ' + obj.len));
          }
        }
      );

      logger.debug('ziti.ziti_websocket_connect rc is (%o)', rc);

      if (rc < 0) {
        reject(
          new Error('Ziti init failed rc [' + rc + '], identity is invalid')
        );
      }
    });
  }

  /**
   * Connect to a Ziti service.
   * @param {object} param
   * @param {string} [param.host] the host to connect to. Default is localhost
   * @param {number} param.port the port to connect to. Required.
   * @return {ZitiSocket}
   */
  async connect(url) {
    const self = this;
    const headersArray = [];

    for (const key of Object.keys(this.opts.headers)) {
      if (key === 'Cookie') {
        let hdr;
        let value = '';
        let cookiearray = this.opts.headers[key].split(';');
        cookiearray.forEach((element) => {
          if (value.length > 0) {
            value += ';';
          }
          value += element;
        });
        hdr = key + ':' + value;
        headersArray.push(hdr);
      }
    }

    this.zitiWebsocket = await this._get_ziti_websocket(
      url,
      headersArray
    ).catch((e) => {
      logger.error('get_ziti_websocket Error: %o', e);
    });

    if (typeof this.zitiWebsocket === 'undefined') {
      return false;
    } else {
      this.emit('connect');
      return true;
    }
  }

  /**
   *
   */
  async _read() {
    /* NOP */
  }

  /**
   * Returna a Promise that will resolve _only_ after a Ziti connection has been established for this instance of ZitiSocket.
   */
  getZitiConnection() {
    const self = this;
    return new Promise((resolve) => {
      (function waitForConnected() {
        if (self.zitiWebsocket) return resolve(self.zitiWebsocket);
        setTimeout(waitForConnected, 10);
      })();
    });
  }

  connAsHex(conn) {
    if (conn < 0) {
        conn = 0xFFFFFFFF + conn + 1;
    }
    return '0x' + conn.toString(16);
  }

  /**
   * Implements the writeable stream method `_write` by pushing the data onto the underlying Ziti connection.
   * It is possible that this function is called before the Ziti connect has completed, so this function will (currently)
   * await Ziti connection establishment (as opposed to buffering the data).
   */
  async write(chunk, encoding, cb) {
    const self = this;
    let buffer;
    let callback;

    if (typeof chunk === 'string' || chunk instanceof String) {
      buffer = Buffer.from(chunk, encoding);
      callback = cb;
    } else if (Buffer.isBuffer(chunk)) {
      buffer = chunk;
      callback = encoding;
    } else {
      throw new Error(
        'chunk type of [' + typeof chunk + '] is not a supported type'
      );
    }

    let results;

    if (buffer.length > 0) {
      const ws = await this.getZitiConnection().catch((e) =>
        logger.error('inside ziti-socket.js _write(), Error 1: ', e.message)
      );
      logger.info('ZitiSocket write ---> ws=[%o] len=[%o] data=[%o]', ws, buffer.length, buffer.toString());

      results = await this.ziti_websocket_write(ws, buffer).catch((e) => {
        logger.error('write(), Error: %o', e);
        self.emit('error', e);
      });
    }

    logger.info('ZitiSocket write ---> results=[%o]', results);


    // Check for errors at Ziti level, and emit error event if needed
    if (typeof results !== 'undefined') {
      if (results.status < 0) {
        logger.error('write(), results.status: [%o]', results.status);
        self.emit('error', new Error('ZitiSocket write failed: status=' + results.status));
      }
    }

    if (callback !== undefined) {
      if (results) {
        if (results.status < 0) {
          callback(
            new Error('ZitiSocket write failed: status=' + results.status)
          );
        } else {
          callback();
        }
      } else {
        callback();
      }
    }
  }

  /**
   * Implements the writeable stream method `_final` used when .end() is called to write the final data to the stream.
   */
  _final(cb) {
    logger.debug('ZitiSocket._final entered');
    cb();
  }

  /**
   *
   */
  setTimeout() {
    /* NOP */
  }

  /**
   *
   */
  setNoDelay() {
    /* NOP */
  }
}
