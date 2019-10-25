/* Packages */
const express = require('express');
const createError = require('http-errors');
const multer  = require('multer')
const assert = require('assert');
const mongodb = require('mongodb');
const md5file = require('md5-file');
const rdesc = require('rdesc-parser');
const fs = require('fs');

/* Local variables */
const upload = multer({ dest: '/tmp/' })
const router = express.Router();
const uri = 'mongodb://localhost:27017';

mongodb.MongoClient.connect(uri, function(error, client) {
	assert.ifError(error);
	const db = client.db('cranlike');
	global.bucket = new mongodb.GridFSBucket(db, {bucketName: 'files'});
	global.packages = db.collection('packages');
});

/* Routers */
router.get('/', function(req, res, next) {
	packages.distinct('_user').then(function(x){
		console.log(x);
		res.send(x);
	}, function(err){
		next(createError(400, err));
	});
});

router.get('/:user', function(req, res, next) {
	var user = req.params.user;
	packages.distinct('Package', {_user : user}).then(function(x){
		if(x.length){
			res.send(['archive', 'bin', 'old', 'src']);
		} else {
			next(createError(404, "No such user"));
		}
	}, function(err){
		next(createError(400, err));
	});
});

router.get('/:user/src', function(req, res, next) {
	var user = req.params.user;
	packages.distinct('Package', {_user : user}).then(function(x){
		if(x.length){
			res.send(['contrib']);
		} else {
			next(createError(404, "No such user"));
		}
	}, function(err){
		next(createError(400, err));
	});
});

router.get('/:user/src/contrib', function(req, res, next) {
	var user = req.params.user;
	packages.find({_user: user, _type: 'src'}).toArray(function(err, docs){
		if(err){
			next(createError(400, err));
		} else {
			const map = docs.map(function(x){
				return x.Package + "_" + x.Version + ".tar.gz";
			});
			res.send(map)
		}
	});
});

router.get('/:user/bin', function(req, res, next) {
	var user = req.params.user;
	packages.distinct('Package', {_user : user}).then(function(x){
		if(x.length){
			res.send(['windows', 'macosx']);
		} else {
			next(createError(404, "No such user"));
		}
	}, function(err){
		next(createError(400, err));
	});
});

router.get('/:user/archive', function(req, res, next) {
	var user = req.params.user;
	packages.distinct('Package', {_user : user}).then(function(x){
		console.log(x);
		res.send(x);
	}, function(err){
		next(createError(400, err));
	});
});

router.get('/:user/archive/:package', function(req, res, next) {
	var user = req.params.user;
	var package = req.params.package
	packages.distinct('Version', {_user : user, Package : package}).then(function(x){
		console.log(x);
		res.send(x);
	}, function(err){
		next(createError(400, err));
	});
});

router.get('/:user/archive/:package/:version', function(req, res, next) {
	var user = req.params.user;
	var package = req.params.package
	var version = req.params.version;
	packages.find({_user : user, Package : package, Version : version}).toArray(function(err, docs){
		if(err){
			next(createError(400, err));
		} else {
			res.send(docs);
		}
	});
});

router.post('/:user/archive/:package/:version', upload.fields([{ name: 'file', maxCount: 1 }]), function(req, res, next) {
	console.log(req.files);
	console.log(req.body);
	var user = req.params.user;
	var package = req.params.package;
	var version = req.params.version;
	var type = req.body.type;
	if(['src', 'win', 'mac'].indexOf(type) < 0){
		next(createError(400, "Parameter 'type' must be one of src, win, mac"));
	} else if(!req.files.file || !req.files.file[0]){
		next(createError(400, "Missing parameter 'file' in upload"));
	} else {
		var filepath = req.files.file[0].path;
		var filename = req.files.file[0].originalname;
		rdesc.parse_file(filepath, function(err, data) {
			if(err){
				next(createError(400, err));
			} else if(data.Package != package || data.Version != version) {
				next(createError(400, 'Package name or version does not match upload'));
			} else { 
				if(type == 'src' && data.Built) {
					next(createError(400, 'Source package has a "built" field (binary pkg?)'));
				} else if((type == 'win' || type == 'mac') && !data.Built) {
					next(createError(400, 'Binary package is does not have valid Built field'));
				} else if(type == 'win' && data.Built.OStype != 'windows') {
					next(createError(400, 'Windows Binary package has unexpected OStype:' + data.Built.OStype));
				} else if(type == 'mac' && data.Built.OStype != 'unix') {
					next(createError(400, 'MacOS Binary package has unexpected OStype:' + data.Built.OStype));
				} else if(type == 'mac' && data.Built.Platform && !data.Built.Platform.match('apple')) {
					//Built.Platform is missing for binary pkgs without copiled code
					next(createError(400, 'MacOS Binary package has unexpected Platform:' + data.Built.Platform));
				} else {
					const MD5sum = md5file.sync(filepath);
					bucket.delete(MD5sum).then(function(){
						console.log("Replacing previous file " + MD5sum);
					}, function(err){
						console.log("New file " + MD5sum);
					}).finally(function(){
						fs.createReadStream(filepath).
						pipe(bucket.openUploadStreamWithId(MD5sum, filename)).on('error', function(err) {
							next(createError(400, err));
						}).on('finish', function() {
							data['_user'] = user;
							data['_type'] = type;
							data['MD5sum'] = MD5sum;
							data['_file'] = filename;
							data['_published'] = new Date();
							var filter = {_user : user, _type : type, Package : package, Version : version};
							packages.findOneAndReplace(filter, data, {upsert: true, returnOriginal: true}, function(err, result) {
								var original = result.value;
								if(err){
									next(createError(400, err));
								} else if(original){
									// delete the file if there are no other references to the hash
									var orighash = original['MD5sum'];
									packages.findOne({MD5sum : orighash}).then(function(doc){
										if(doc){
											console.log("Found other references, not deleting file: " + orighash);
										} else {
											bucket.delete(orighash).then(function(){
												console.log("Deleted file " + orighash);
											}, function(err){
												console.log("Failed to delete " + orighash + ": " + err);
											});
										}
									}).finally(function(){
										res.send("Succesfully replaced " + filename + '\n');
									});
								} else {
									res.send("Succesfully uploaded " + filename + '\n');
								}
							});
						});
					});
				}
			}
		});
	}
});

module.exports = router;
