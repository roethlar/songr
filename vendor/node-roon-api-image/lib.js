"use strict";

let SVCNAME = "com.roonlabs.image:1";

/**
 * Roon API Image Service
 * @class RoonApiImage
 * @param {Core} core - The Core providing the service
 */
function RoonApiImage(core) {
    this.core = core;
}

RoonApiImage.services = [ { name: SVCNAME } ];

/**
 * @callback RoonApiImage~imageresultcallback
 * @param {string | false} error - an error code or false if no error
 * @param {string} content_type - the MIME type of the image data
 * @param {Buffer} image - the image data
 */

/**
 * <p style='white-space: pre-wrap;'>
 * Roon API services provide image_key properties. This translates the image_key into an actual image.
 *
 * It is also possible to issue image requests directly using HTTP if that is more convenient:
 *
 * <tt>http://IP:PORT/api/image/image_key?scale=XXX&width=XXX&height=XXX&format=XXX</tt>
 *
 * The rules for parameter types and optional/required follow the same as for the options parameter.
 * </p>
 *
 * @param {string} image_key - the key, as given by another api
 * @param {object} [options]
 * @param {('fit'|'fill'|'stretch')} [options.scale] - If this is not set, the image will be returned at original size. Warning: that could be very large!
 * @param {number} [options.width] - The image width to be returned. Required if the scale property is set
 * @param {number} [options.height] - The image height to be returned. Required if the scale property is set
 * @param {('image/jpeg'|'image/png')} [options.format] - If you don't specify, Roon will choose for you.
 * @param {RoonApiImage~imageresultcallback} cb - Called on success or error
 */
RoonApiImage.prototype.get_image = function() {
    var i = 0;
    let image_key = arguments[i++];
    let opts = {};
    if (typeof(arguments[i]) != "function") opts = arguments[i++];
    let cb  = arguments[i++];
    opts = Object.assign({ image_key: image_key }, opts);
    this.core.moo.send_request(SVCNAME+"/get_image",
                               opts,
                               (msg, body) => {
                                   if (msg && msg.name == "Success") cb(false, msg.content_type, body);
                                   else cb(msg ? msg.name : "NetworkError");
                               });
};

exports = module.exports = RoonApiImage;
