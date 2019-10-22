var tar = require('tar-stream');
var gunzip = require('gunzip-maybe');
var fs = require('fs');
var desc = require('rdesc-parser');

function get_package_data(tarball, callback) {

  var extract = tar.extract();
  var done = false;

  extract.on('entry', function(header, stream, tarcb) {
    if (!done && header.name.match(/^[^\/]+\/DESCRIPTION$/)) {
      done = true;
      stream.setEncoding('utf8');
      desc(stream, function(err, description) {
	if (err) { return callback(err); }
	var maint = description.Maintainer;
	if (!!maint) {
	  description.maint = maint.replace(/^.*<(.*)>.*$/, "$1");
	}

	callback(null, description);
	extract.destroy();
      })
    } else {
      tarcb()
    }

    stream.resume();
  });

  extract.on('finish', function() {
    if (!done) { callback('No DESCRIPTION file'); }
  })

  extract.on('error', function() {
    callback('Cannot get DESCRIPTION data, not an R package?');
    extract.destroy();
  })

  fs.createReadStream(tarball)
    .pipe(gunzip())
    .pipe(extract);
}

module.exports = get_package_data;
