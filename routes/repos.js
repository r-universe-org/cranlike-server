/* Packages */
const express = require('express');
const createError = require('http-errors');
const zlib = require('zlib');
const router = express.Router();

/* Fields included in PACKAGES indices */
/* To do: once DB is repopulated, we can remove Imports, Suggests, etc in favor of _dependencies */
const pkgfields = {_id: 0, _hard_deps: 1, _soft_deps: 1, Package: 1, Version: 1, Depends: 1, Suggests: 1, License: 1,
	NeedsCompilation: 1, Imports: 1, LinkingTo: 1, Enhances: 1, License_restricts_use: 1,
	OS_type: 1, Priority: 1, License_is_FOSS: 1, Archs: 1, Path: 1, MD5sum: 1, Built: 1};

function error_cb(status, next) {
	return function(err) {
		next(createError(status, err));
	}
}

function dep_to_string(x){
	if(x.package && x.version){
		return x.package + " (" + x.version + ")";
	} else if(x.package) {
		return x.package
	} else {
		return x;
	}
}

function unpack_deps(x){
	var hard_deps = x['_hard_deps'] || [];
	var soft_deps = x['_soft_deps'] || [];
	var alldeps = hard_deps.concat(soft_deps);
	var deptypes = new Set(alldeps.map(dep => dep.role));
	deptypes.forEach(function(type){
		x[type] = alldeps.filter(dep => dep.role == type);
	});
	delete x['_hard_deps'];
	delete x['_soft_deps'];
	return x;
}

function doc_to_dcf(doc){
	var x = unpack_deps(doc);
	let keys = Object.keys(x);
	return keys.map(function(key){
		let val = x[key];
		if(Array.isArray(val))
			val = val.map(dep_to_string).join(", ");
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
			mac : 'bin/macosx/contrib/'
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

function find_by_user(_user, _type){
	var out = {};
	if(_user != ':any')
		out._user = _user;
	if(_type)
		out_type = _type;
	return out;
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
router.get('/:user/bin/macosx/:xcode?/contrib/:built/PACKAGES\.:ext?', function(req, res, next) {
	var query = {_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}};
	packages_index(query, req.params.ext, res, next);
});

router.get('/:user/bin/macosx/:xcode?/contrib/:built/', function(req, res, next) {
	var query = {_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built}};
	packages_index(query, 'json', res, next);
});

/* Index available R builds for binary pkgs */
router.get('/:user/bin/windows/contrib', function(req, res, next) {
	count_by_built(req.params.user, 'win').pipe(res);
});

router.get('/:user/bin/macosx/:xcode?/contrib', function(req, res, next) {
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

router.get('/:user/bin/macosx/:xcode?/contrib/:built/:pkg.tgz', function(req, res, next) {
	var pkg = req.params.pkg.split("_");
	var query = {_user: req.params.user, _type: 'mac', 'Built.R' : {$regex: '^' + req.params.built},
		Package: pkg[0], Version: pkg[1]};
	send_binary(query, 'application/x-gzip', res, next);
});

/* Public aggregated data (these support :any users)*/
router.get('/:user/stats/checks', function(req, res, next) {
	var query = find_by_user(req.params.user);
	packages.aggregate([
		{$match: query},
		{$group : {
			_id : { package:'$Package', version:'$Version', user: '$_user'},
			runs : { $addToSet: { type: "$_type", builder: "$_builder", built: '$Built', date:'$_published'}}
		}},
		{$project: {
			_id: 0, user: '$_id.user', package: '$_id.package', version:'$_id.version', runs:1}
		}
	])
	.transformStream({transform: doc_to_ndjson})
	.pipe(res.type('text/plain'));
});

router.get("/:user/stats/maintainers", function(req, res, next) {
	var query = find_by_user(req.params.user, 'src');
	packages.aggregate([
		{$match: query},
		{$set: { email: { $regexFind: { input: "$Maintainer", regex: /^(.+)<(.*)>$/ } } } },
		{$project: {
			_id: 0,
			package: '$Package',
			version: '$Version',
			date: '$Date',
			user: '$_user',
			name: { $trim: { input: { $arrayElemAt: ['$email.captures',0]}}},
			email: { $arrayElemAt: ['$email.captures',1]}
		}},
		{$unwind: '$email'},
		{$group: {
			_id : '$email',
			name : { $first: '$name'},
			packages : { $addToSet: {
				package: '$package',
				version: '$version',
				user: '$user',
				date: '$date'
			}}
		}},
		{$project: {_id: 0, name: '$name', email: '$_id', packages: '$packages'}},
		{$sort:{ email: 1}}
	])
	.transformStream({transform: doc_to_ndjson})
	.pipe(res.type('text/plain'));
});

router.get("/:user/stats/revdeps", function(req, res, next) {
	var query = find_by_user(req.params.user, 'src');
	packages.aggregate([
		{$match: query},
		{$project: {_id: 0, user: '$_user', package: '$Package', dependencies: {$concatArrays: ['$_hard_deps', '$_soft_deps']}}},
		{$unwind: '$dependencies'},
		{$group: {
			_id : '$dependencies.package',
			revdeps : { $addToSet: 
				{user: '$user', package: '$package', role: '$dependencies.role', version: '$dependencies.version'}}
		}},
		{$project: {_id: 0, package: '$_id', revdeps: '$revdeps'}},
		{$sort:{ package: 1}}
	])
	.transformStream({transform: doc_to_ndjson})
	.pipe(res.type('text/plain'));
});

router.get("/:user/stats/sysdeps", function(req, res, next) {
	var query = find_by_user(req.params.user, 'src');
	packages.aggregate([
		{$match: query},
		{$project: {_id: 0, user: '$_user', package: '$Package', sysdeps: '$_builder.sysdeps.package'}},
		{$unwind: '$sysdeps'},
		{$group: {
			_id : '$sysdeps',
			packages : { $addToSet: {user: '$user', package:'$package'}}
		}},
		{$project: {_id: 0, sysdep: '$_id', packages: '$packages'}},
		{$sort:{ sysdep: 1}}
	])
	.transformStream({transform: doc_to_ndjson})
	.pipe(res.type('text/plain'));
});

/* Below haven't been generalized to :any (yet) */
router.get("/:user/stats/rundeps", function(req, res, next) {
	packages.aggregate([
		{$match: {_user: req.params.user, _type: 'src'}},
		{ $graphLookup: {
			from: "packages",
			startWith: "$_hard_deps.package",
			connectFromField: "_hard_deps.package",
			connectToField: "Package",
			as: "DependencyHierarchy"
		}},
		{ $project: {Package: 1, rundeps: {'$setUnion': ['$DependencyHierarchy.Package']}}}
	])
	.transformStream({transform: doc_to_ndjson})
	.pipe(res.type('text/plain'));
});

router.get("/:user/stats/checkdeps", function(req, res, next) {
	packages.aggregate([
		{$match: {_user: req.params.user, _type: 'src'}},
		{ $project: {_id: 0, Package: 1, deps: {$concatArrays: ['$_hard_deps', '$_soft_deps']}}},
		{ $graphLookup: {
			from: "packages",
			startWith: "$deps.package",
			connectFromField: "_hard_deps.package",
			connectToField: "Package",
			as: "DependencyHierarchy"
		}},
		{ $project: {Package: 1, checkdeps: {'$setUnion': ['$DependencyHierarchy.Package']}}}
	])
	.transformStream({transform: doc_to_ndjson})
	.pipe(res.type('text/plain'));
});


module.exports = router;
