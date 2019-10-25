const express = require('express');
const createError = require('http-errors');
const zlib = require('zlib');
const router = express.Router();
const pkgfields = {_id: 0, Package: 1, Version: 1, Depends: 1, Suggests: 1, License: 1,
	NeedsCompilation: 1, Imports: 1, LinkingTo: 1, Enhances: 1, License_restricts_use: 1,
	OS_type: 1, Priority: 1, License_is_FOSS: 1, Archs: 1, Path: 1, MD5sum: 1};
function write_packages(data){
	return data.map(function(x){
		x.MD5sum = x['MD5sum'];
		let keys = Object.keys(x);
		return keys.map(function(key){
			let val = x[key];
			if(Array.isArray(val))
				val = val.join(", ");
			return key + ": " + val.replace('\n', ' ');
		}).join("\n");
	}).join("\n\n");
}

function packages_index(query, format, res, next){
	packages.find(query).project(pkgfields).toArray(function(err, docs){
		if(err){
			next(createError(400, err));
		} else {
			const text = write_packages(docs);
			if(!format){
				res.type('text/plain');
				res.set('Cache-Control', 'no-cache');
				res.send(text);
			} else if(format == 'gz') {
				zlib.gzip(text, function(err, buffer){
					if(err){
						next(createError(400, "Failed to create gzip"));
					} else {
						res.type('application/x-gzip');
						res.set('Cache-Control', 'no-cache');
						res.send(buffer);
					}
				});
			} else {
				next(createError(404, "Unsupported format: " + format));
			}
		}
	});
}

/* Source packages */
router.get('/:user/src/contrib/PACKAGES\.:ext?', function(req, res, next) {
	packages_index({_user: req.params.user, _type: 'src'}, req.params.ext, res, next);
});

router.get('/:user/src/contrib/:pkg.tar.gz', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = {_user: req.params.user, _type: 'src', Package: pkg[0], Version: pkg[1]};
	packages.findOne(query, {project: {MD5sum: 1}}, function(err, docs){
		if(err){
			next(createError(400, err))
		} else if(!docs){
			next(createError(404, 'Package not found'));
		} else {
			res.type('application/x-gzip');
			bucket.openDownloadStream(docs.MD5sum).pipe(res);
		}
	});
});

/* Windows packages */
router.get('/:user/bin/windows/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
	var query = {_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}};
	packages_index(query, req.params.ext, res, next);
});

router.get('/:user/bin/windows/contrib/:built/:pkg.zip', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = {_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built},
		Package: pkg[0], Version: pkg[1]};
	packages.findOne(query, {project: {MD5sum: 1}}, function(err, docs){
		if(err){
			next(createError(400, err))
		} else if(!docs){
			next(createError(404, 'Package not found'));
		} else {
			res.type('application/zip');
			bucket.openDownloadStream(docs.MD5sum).pipe(res);
		}
	});
});

/* MacOS packages */
router.get('/:user/bin/macosx/el-capitan/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
	var query = {_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}};
 	packages_index(query, req.params.ext, res, next);
});

router.get('/:user/bin/macosx/el-capitan/contrib/:built/:pkg.tgz', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = {_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built},
		Package: pkg[0], Version: pkg[1]};
	packages.findOne(query, {project: {MD5sum: 1}}, function(err, docs){
		if(err){
			next(createError(400, err))
		} else if(!docs){
			next(createError(404, 'Package not found'));
		} else {
			res.type('application/x-gzip');
			bucket.openDownloadStream(docs.MD5sum).pipe(res);
		}
	});
});

router.get('/:user/old', function(req, res, next) {
  res.send('Archive for: ' + req.params.user);
});

router.get('/:user/old/:date', function(req, res, next) {
  res.send('Archive for: ' + req.params.user + ' on date: ' + req.params.date);
});


module.exports = router;
