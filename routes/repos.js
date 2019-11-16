/* Packages */
const express = require('express');
const createError = require('http-errors');
const zlib = require('zlib');
const router = express.Router();

/* Fields included in PACKAGES indices */
const pkgfields = {_id: 0, Package: 1, Version: 1, Depends: 1, Suggests: 1, License: 1,
	NeedsCompilation: 1, Imports: 1, LinkingTo: 1, Enhances: 1, License_restricts_use: 1,
	OS_type: 1, Priority: 1, License_is_FOSS: 1, Archs: 1, Path: 1, MD5sum: 1, Built: 1};

/* Error generator */
function error_cb(status, next) {
	return function(err) {
		next(createError(status, err));
	}
}

/* Helpers */
function doc_to_dcf(x){
	let keys = Object.keys(x);
	return keys.map(function(key){
		let val = x[key];
		if(Array.isArray(val))
			val = val.join(", ");
		else if(key == 'Built')
			val = "R " + Object.values(val).join("; ");
		return key + ": " + val.replace(/\s/gi, ' ');
	}).join("\n") + "\n\n";
}

function doc_to_ndjson(x){
	return JSON.stringify(x) + '\n';
}

function doc_to_filename(x){
	const ext = {
		src: ".tar.gz",
		win: ".zip",
		mac: ".tgz"
	};
	return x.Package + "_" + x.Version + ext[x['_type']] + '\n';
}

function packages_index(query, format, res, next){
	var input = packages.find(query).project(pkgfields);
	res.set('Cache-Control', 'no-cache');
	if(!format){
		input
			.transformStream({transform: doc_to_dcf})
			.pipe(res.type('text/plain'));
	} else if(format == 'gz'){
		input
			.transformStream({transform: doc_to_dcf})
			.pipe(zlib.createGzip())
			.pipe(res.type('application/x-gzip'));
	} else if(format == 'json'){
		input
			.transformStream({transform: doc_to_ndjson})
			.pipe(res.type('text/plain'));
	} else {
		next(createError(404, 'Unknown PACKAGES format: ' + format));
	}
}

function html_index(query, res){
	packages
		.find(query)
		.project({_id:0, Package:1, Version:1, _type:1})
		.transformStream({transform: doc_to_filename})
		.pipe(res.type('text/plain'));
}

function count_by_user(){
	return packages.aggregate([
		{$group:{_id: "$_user", count: { $sum: 1 }}}
	])
	.project({_id: 0, user: "$_id", count: 1})
	.transformStream({transform: doc_to_ndjson});
}

function count_by_type(user){
	return packages.aggregate([
		{$match: {_user: user}},
		{$group:{_id: "$_type", count: { $sum: 1 }}}
	])
	.project({_id: 0, type: "$_id", count: 1})
	.transformStream({transform: function(x){
		const dirname = {
			src : 'src/contrib',
			win : 'bin/windows/contrib',
			mac : 'bin/macosx/el-capitan/contrib/'
		};
		x.path = dirname[x.type];
		return doc_to_ndjson(x);
	}});
}

function count_by_built(user, type){
	return packages.aggregate([
		{$match: {_user: user, _type : type}},
		{$group:{_id: "$Built.R", count: { $sum: 1 }}}
	])
	.project({_id: 0, R: "$_id", count: 1})
	.transformStream({transform: doc_to_ndjson});
}

function send_binary(query, content_type, res, next){
	packages.findOne(query, {project: {MD5sum: 1, Redirect: 1}}).then(function(docs){
		if(!docs){
			next(createError(404, 'Package not found'));
		} else if(docs.Redirect) {
			res.status(301).redirect(docs.Redirect)
		} else {
			bucket.openDownloadStream(docs.MD5sum).pipe(res.type(content_type));
		}
	}).catch(error_cb(400, next));	
}

/* Copied from api.js */
router.get('/', function(req, res, next) {
	count_by_user().pipe(res);
});

router.get('/:user', function(req, res, next) {
	count_by_type(req.params.user).pipe(res);
});

/* CRAN-like index for source packages */
router.get('/:user/src/contrib/PACKAGES\.:ext?', function(req, res, next) {
	packages_index({_user: req.params.user, _type: 'src'}, req.params.ext, res, next);
});

router.get('/:user/src/contrib/', function(req, res, next) {
	packages_index({_user: req.params.user, _type: 'src'}, 'json', res, next);
});

/* CRAN-like index for Windows packages */
router.get('/:user/bin/windows/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
	var query = {_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}};
	packages_index(query, req.params.ext, res, next);
});

router.get('/:user/bin/windows/contrib/:built/', function(req, res, next) {
	var query = {_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built}};
	packages_index(query, 'json', res, next);
});

/* CRAN-like index for MacOS packages */
router.get('/:user/bin/macosx/el-capitan/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
	var query = {_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}};
	packages_index(query, req.params.ext, res, next);
});

router.get('/:user/bin/macosx/el-capitan/contrib/:built/', function(req, res, next) {
	var query = {_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}};
	packages_index(query, 'json', res, next);
});

/* Index available R builds for binary pkgs */
router.get('/:user/bin/windows/contrib', function(req, res, next) {
	count_by_built(req.params.user, 'win').pipe(res);
});

router.get('/:user/bin/macosx/el-capitan/contrib', function(req, res, next) {
	count_by_built(req.params.user, 'mac').pipe(res);
});

/* Download package files */
router.get('/:user/src/contrib/:pkg.tar.gz', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = {_user: req.params.user, _type: 'src', Package: pkg[0], Version: pkg[1]};
	send_binary(query, 'application/x-gzip', res, next);
});

router.get('/:user/bin/windows/contrib/:built/:pkg.zip', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = {_user: req.params.user, _type: 'win', 'Built.R' : {$regex: '^' + req.params.built},
		Package: pkg[0], Version: pkg[1]};
	send_binary(query, 'application/zip', res, next);
});

router.get('/:user/bin/macosx/el-capitan/contrib/:built/:pkg.tgz', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = {_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built},
		Package: pkg[0], Version: pkg[1]};
	send_binary(query, 'application/x-gzip', res, next);
});

/* Public aggregated data (subject to change) */
router.get('/:user/stats/checks', function(req, res, next) {
	packages.aggregate([
		{$match: {_user: req.params.user}},
		{$group : {
			_id : { package:'$Package', version:'$Version', maintainer: '$Maintainer'},
			runs : { $addToSet: { type: "$_type", builder: "$_builder", built: '$Built', date:'$_published'}}
		}},
		{$project: {
			_id: 0, package: '$_id.package', version:'$_id.version', maintainer:'$_id.maintainer', runs:1}
		}
	])
	.transformStream({transform: doc_to_ndjson})
	.pipe(res.type('text/plain'));
});

module.exports = router;
