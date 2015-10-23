import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import mkdirp from 'mkdirp';
import _ from 'lodash';
import zlib from 'zlib';

export default class CompileCache {
  constructor() {
    this.stats = {
      hits: 0,
      misses: 0
    };

    this.cacheDir = null;
    this.jsCacheDir = null;
    this.seenFilePaths = {};
  }

  getCompilerInformation() {
    throw new Error("Implement this in a derived class");
  }

  compile(sourceCode, filePath, cachePath) {
    throw new Error("Implement this in a derived class");
  }

  getMimeType() {
    throw new Error("Implement this in a derived class");
  }

  initializeCompiler() {
    throw new Error("Implement this in a derived class");
  }
  
  // Shout out to mafintosh/gunzip-maybe
  static isGzipped(data) {
    if (data.length < 10) return false; // gzip header is 10 bytes
    if (data[0] !== 0x1f && data[1] !== 0x8b) return false; // gzip magic bytes
    if (data[2] !== 8) return false; // is deflating

    return true;
  }

  static isMinified(source) {
    let length = source.length;
    if (length > 1024) length = 1024;

    let newlineCount = 0;

    // Roll through the characters and determine the average line length
    for(let i=0; i < source.length; i++) {
      if (source[i] === '\n') newlineCount++;
    }

    // No Newlines? Any file other than a super small one is minified
    if (newlineCount === 0) {
      return (length > 80);
    }

    let avgLineLength = length / newlineCount;
    return (avgLineLength > 80);
  }

  shouldCompileFile(fullPath, sourceCode=null) {
    this.ensureInitialized();
    let lowerPath = fullPath.toLowerCase();

    // If we're in node_modules or in Electron core code, we're gonna punt
    if (fullPath.match(/[\\\/]node_modules[\\\/]/i) || fullPath.match(/[\\\/]atom\.asar/)) return false;

    // If the file already has a source map, that's a good indication that we
    // shouldn't compile it
    if (sourceCode && sourceCode.lastIndexOf('//# sourceMap') > sourceCode.lastIndexOf('\n')) {
      return false;
    }

    // If the file is minified, we probably shouldn't compile it either
    if (sourceCode && CompileCache.isMinified(sourceCode)) {
      return false;
    }

    // NB: require() normally does this for us, but in our protocol hook we
    // need to do this ourselves
    return _.some(
      this.extensions,
      (ext) => lowerPath.lastIndexOf(ext) + ext.length === lowerPath.length);
  }

  ///
  /// shasum - Hash with an update() method.
  /// value - Must be a value that could be returned by JSON.parse().
  ///
  updateDigestForJsonValue(shasum, value) {
    // Implmentation is similar to that of pretty-printing a JSON object, except:
    // * Strings are not escaped.
    // * No effort is made to avoid trailing commas.
    // These shortcuts should not affect the correctness of this function.
    const type = typeof(value);

    if (type === 'string') {
      shasum.update('"', 'utf8');
      shasum.update(value, 'utf8');
      shasum.update('"', 'utf8');
      return;
    }

    if (type === 'boolean' || type === 'number') {
      shasum.update(value.toString(), 'utf8');
      return;
    }

    if (!value) {
      shasum.update('null', 'utf8');
      return;
    }

    if (Array.isArray(value)) {
      shasum.update('[', 'utf8');
      for (let i=0; i < value.length; i++) {
        this.updateDigestForJsonValue(shasum, value[i]);
        shasum.update(',', 'utf8');
      }
      shasum.update(']', 'utf8');
      return;
    }

    // value must be an object: be sure to sort the keys.
    let keys = Object.keys(value);
    keys.sort();

    shasum.update('{', 'utf8');

    for (let i=0; i < keys.length; i++) {
      this.updateDigestForJsonValue(shasum, keys[i]);
      shasum.update(': ', 'utf8');
      this.updateDigestForJsonValue(shasum, value[keys[i]]);
      shasum.update(',', 'utf8');
    }

    shasum.update('}', 'utf8');
  }

  createDigestForCompilerInformation() {
    let sha1 = crypto.createHash('sha1');
    this.updateDigestForJsonValue(sha1, this.getCompilerInformation());
    return sha1.digest('hex');
  }

  getCachePath(sourceCode) {
    let digest = crypto.createHash('sha1').update(sourceCode, 'utf8').digest('hex');

    if (!this.jsCacheDir) {
      this.jsCacheDir = path.join(this.cacheDir, this.createDigestForCompilerInformation());

      // NB: Even if all of the directories exist, if you mkdirp in an ASAR archive it throws
      if (!this.jsCacheDir.match(/[\\\/]app\.asar/)) {
        mkdirp.sync(this.jsCacheDir);
      }
    }

    return path.join(this.jsCacheDir, `${digest}`);
  }

  getCachedJavaScript(cachePath) {
    try {
      let buf = fs.readFileSync(cachePath);
      if (CompileCache.isGzipped(buf)) {
        buf = zlib.gunzipSync(buf);
      }
      
      let ret = buf.toString('utf8');
      this.stats.hits++;

      return ret;
    } catch (e) {
      return null;
    }
  }

  saveCachedJavaScript(cachePath, js) {
    fs.writeFileSync(cachePath, zlib.gzipSync(new Buffer(js)));
  }

  // Function that obeys the contract of an entry in the require.extensions map.
  // Returns the transpiled version of the JavaScript code at filePath, which is
  // either generated on the fly or pulled from cache.
  loadFile(module, filePath, returnOnly=false, sourceCode=null) {
    this.ensureInitialized();

    let fullPath = path.resolve(filePath);
    this.seenFilePaths[path.dirname(filePath)] = true;

    sourceCode = sourceCode || fs.readFileSync(filePath, 'utf8');

    if (!this.shouldCompileFile(fullPath, sourceCode)) {
      if (returnOnly) return sourceCode;
      return module._compile(sourceCode, filePath);
    }

    // NB: We do all of these backflips in order to not load compilers unless
    // we actually end up using them, since loading them is typically fairly
    // expensive
    if (!this.compilerInformation.version) {
      this.compilerInformation.version = this.initializeCompiler();
    }

    let js = null;
    let cachePath = null;
    if (!this.disableCache) {
      cachePath = this.getCachePath(sourceCode);
      js = this.disableCache ? null : this.getCachedJavaScript(cachePath);
    }

    if (!js) {
      js = this.compile(sourceCode, filePath, cachePath);
      this.stats.misses++;

      if (!this.disableCache) {
        this.saveCachedJavaScript(cachePath, js);
      }
    }

    if (returnOnly) return js;
    return module._compile(js, filePath);
  }

  register() {
    this.ensureInitialized();

    for (let i=0; i < this.extensions.length; i++) {
      Object.defineProperty(require.extensions, `.${this.extensions[i]}`, {
        enumerable: true,
        writable: true,
        value: (module, filePath) => this.loadFile(module, filePath)
      });
    }
  }

  ensureInitialized() {
    if (this.extensions) return;

    let info = this.getCompilerInformation();

    if (!info.extension && !info.extensions) {
      throw new Error("Compiler must register at least one extension in getCompilerInformation");
    }

    this.extensions = (info.extensions ? info.extensions : [info.extension]);
  }

  setCacheDirectory(newCacheDir) {
    this.disableCache = (newCacheDir === null);
    if (this.cacheDir === newCacheDir) return;

    this.cacheDir = newCacheDir;
    this.jsCacheDir = null;
  }
}
