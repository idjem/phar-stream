"use strict";

const fs = require('fs');
const bl = require('bl')
const PassThrough = require('stream').PassThrough;
const Writable    = require('stream').Writable;

const defer  = require('nyks/promise/defer');
const detach = require('nyks/function/detach');

const streamsearch = require('streamsearch');

//find halt compiler
//parse manifest
//receive files stream
const END_STUB = "__HALT_COMPILER(); ?>";


    //search for a stub in a stream, return a promise
function search(stream, needle) {

  var ss = new streamsearch(needle),
      push = ss.push.bind(ss);
  ss.maxMatches = 1;

  var defered = defer();
  stream.on("data", push);

  stream.once("finish", function(){
    defered.reject("No stub found in stream")
  });

  var pos = 0;

  ss.on("info", function(isMatch, data, start, end){
    if(data)
      pos += end - start;

    if(!isMatch)
      return;

    stream.removeListener("data", push);
    defered.resolve(pos);
  });
  return defered;
}



class Source extends PassThrough {
  constructor(self, offset) {
    super();
  }
}


class Extract extends Writable {

  constructor() {
    super();
    this.run().catch(detach(this.emit, this, 'error'));
  }


    //make sure internal buffer contains AT LEAST size buffer
  need(size) {
    var defered = defer();
    this._missing = size;

    var hole =  () => {
      if(this._buffer.length < size)
        return;
      this.removeListener('data', hole);
      this._missing = 0;
      defered.resolve();
    };

    this.on('data', hole); hole();
    return defered;
  }


  async run() {
    var body = this._buffer = bl();

    this._missing = 1 << 10 << 10; //1MB max stub size (arbitrary)

    var pos = (await search(this, END_STUB)) + END_STUB.length;

    var p0 = this._buffer.get(pos), p1 = this._buffer.get(pos + 1);
    if(p0 == 13 && p1 == 10) pos+=2;
    if(p0 == 10) pos+=1;

    var mlen  = this._buffer.readUInt32LE(pos);

    this._buffer.consume(pos + 4);
    await this.need(mlen); //waiting until at least mlen bytes are available

    var body = this._buffer.slice(0, mlen); pos = 0;
    this._buffer.consume(mlen);

    function readInt() {
      var ret = body.readUInt32LE(pos); pos+= 4;
      return ret;
    }

    function readString() {
      var len = readInt(), ret = body.slice(pos, pos + len); pos += len;
      return "" + ret;
    }


    var files_nb  = readInt();
    var version   = body.readUInt16LE(pos); pos+= 2;
    var flags     = readInt()
    var alias     = readString()
    var metadata  = readString();

    //console.log({files_nb, version, flags, alias, metadata});


    var entries = [], entry;

    //https://github.com/php/php-src/blob/master/ext/phar/phar.c#L1059
    for(var manifest_index = 0; manifest_index < files_nb; ++manifest_index) {
      entry = {
        'entry_name' : readString(),
        'entry_size' : readInt(),
        'entry_mtime' : readInt(),
        'entry_csize' : readInt(),
        'entry_crc32' : readInt(),
        'entry_flags' : readInt(),
        'entry_meta'  : readString(),
      }
      entries.push(entry);
    }

    //the whole manifest has been parsed, let's extract some files

    for(entry of entries) {
      var stream = this._stream = new Source();
      var defered = defer();

      this.emit("entry", entry, stream, defered.resolve);
      this._missing = entry.entry_csize;

      if(this._buffer.length) {
        var tmp = this._buffer; this._buffer = bl();
        this._write(tmp.slice(0, tmp.length), undefined, this._cb);
      }

      await defered; //wait for the entry to be consumed
    }

       //last chunk has been wrote, closing extract stream

    if(this._cb)
      this._cb();

    detach(this.emit, this)("extracted");
  }

  _write(data, enc, cb) {

    this.emit("data", data);

    var s = this._stream
    var b = this._buffer
    var missing = this._missing

      //not enough data, looping
    if (data.length < this._missing) {

      this._missing -= data.length
      if (s)
        return s.write(data, cb)

      b.append(data)
      return cb()
    }

    this._cb = cb; 
    this._missing = 0

    if (data.length > missing && s) {
      s.end( data.slice(0, missing) );
      data = data.slice(missing);
      this._stream = null;
    }

    b.append(data);
  }
}




module.exports = { extract : Extract };

