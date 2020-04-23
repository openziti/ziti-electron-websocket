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
const { Readable } = require('stream').Readable;
const logger = require('electron-log');

export class ZitiSocket extends Duplex {
  constructor(ziti) {
    super();

    this.ziti = ziti; // the Ziti native addon (a.k.a. ziti-sdk-nodejs)
    logger.info('ZitiSocket.ctor entered, this.ziti: %o', this.ziti);

    /**
     * This stream is where we'll put any data returned from a Ziti connection (see NF_dial.data.call_back)
     */
    this.readableZitiStream = new Readable();
    this.readableZitiStream._read = function() {};

    /**
     * The underlying Ziti Connection
     * @private
     * @type {string}
     */
    this.zitiConnection;

    /**
     * Start the async iterator on the Ziti stream.
     */
    setImmediate(this._pumpZitiStream.bind(this));
  }

  /**
   * Pump all data arriving from Ziti connection out into the Duplex stream represented by this ZitiSocket object
   */
  async _pumpZitiStream() {
    // Block here waiting for a chunk of data
    for await (const chunk of this.readableZitiStream) {
      // Push the chunk into the Duplex.  If we experience back-pressure, wait for things to drain.
      if (!this.push(chunk))
        await new Promise((res) => {
          this.once('drain', res);
        });
    }
  }

  /**
   * Make a connection to the specified Ziti 'service'.  We do this by invoking the NF_dial() function in the Ziti NodeJS-SDK.
   * @param {*} service
   */
  NF_dial(service) {
    logger.info('ZitiSocket.NF_dial entered, service: %s', service);

    const self = this;
    return new Promise((resolve) => {
      if (self.zitiConnection) {
        resolve(self.zitiConnection);
      } else {
        self.ziti.NF_dial(
          service,

          true, // This IS a websocket

          /**
           * on_connect callback.
           */
          (conn) => {
            logger.info(
              'ZitiSocket.NF_dial.on_connect callback entered, conn: %p',
              conn
            );

            resolve(conn);
          },

          /**
           * on_data callback (we receive a Buffer containing uint8_t's from the NodeJS SDK)
           */
          (data) => {
            logger.info(
              'ZitiSocket.NF_dial.on_data callback entered, raw data: %o',
              data
            );
            logger.info(
              'ZitiSocket.NF_dial.on_data callback entered, stringified data: \n%s',
              data.toString()
            );
            this.readableZitiStream.push(data);
          }
        );
      }
    });
  }

  /**
   * Write data onto the underlying Ziti connection by invoking the NF_write() function in the Ziti NodeJS-SDK.  The
   * NodeJS-SDK expects incoming data to be of type Buffer.
   */
  NF_write(conn, buffer) {
    const self = this;
    return new Promise((resolve) => {
      self.ziti.NF_write(conn, buffer, () => {
        resolve();
      });
    });
  }

  /**
   * Connect to a Ziti service.
   * @param {object} param
   * @param {string} [param.host] the host to connect to. Default is localhost
   * @param {number} param.port the port to connect to. Required.
   * @return {ZitiSocket}
   */
  async connect(opts) {
    this.zitiConnection = await this.NF_dial(opts.host).catch((e) =>
      logger.error('connect Error: %o', e)
    );
  }

  /**
   *
   */
  _read() {
    /* NOP */
  }

  /**
   * Returna a Promise that will resolve _only_ after a Ziti connection has been established for this instance of ZitiSocket.
   */
  getZitiConnection() {
    const self = this;
    return new Promise((resolve) => {
      (function waitForConnected() {
        if (self.zitiConnection) return resolve(self.zitiConnection);
        setTimeout(waitForConnected, 10);
      })();
    });
  }

  /**
   * Implements the writeable stream method `_write` by pushing the data onto the underlying Ziti connection.
   * It is possible that this function is called before the Ziti connect has completed, so this function will (currently)
   * await Ziti connection establishment (as opposed to buffering the data).
   */
  async write(chunk, encoding, cb) {
    if (encoding !== undefined) {
      logger.info('ZitiSocket.write entered, encoding: ', encoding);
      if (typeof chunk === 'string' || chunk instanceof String) {
        logger.info('ZitiSocket.write entered, chunk: ', chunk);
      }
    } else {
      logger.info('ZitiSocket.write entered, encoding is not present');
    }

    let buffer;

    if (typeof chunk === 'string' || chunk instanceof String) {
      buffer = Buffer.from(chunk, 'utf8');
    } else if (Buffer.isBuffer(chunk)) {
      buffer = chunk;
    } else {
      throw new Error(
        'chunk type of [' + typeof chunk + '] is not a supported type'
      );
    }

    if (buffer.length > 0) {
      logger.info('ZitiSocket.write buffer.length: %o', buffer.length);

      const conn = await this.getZitiConnection().catch((e) =>
        logger.error('inside ziti-socket.js _write(), Error 1: ', e.message)
      );
      logger.info('ZitiSocket.write conn: %o', conn);

      await this.NF_write(conn, buffer).catch((e) =>
        logger.error('write(), Error: %o', e)
      );
    }

    if (cb !== undefined) {
      cb();
    }
  }

  /**
   * Implements the writeable stream method `_final` used when .end() is called to write the final data to the stream.
   */
  _final(cb) {
    logger.info('ZitiSocket._final entered');

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
