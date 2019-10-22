/* Packages */
const express = require('express');
const createError = require('http-errors');
const multer  = require('multer')
const assert = require('assert');
const mongodb = require('mongodb');
const md5file = require('md5-file');
const fs = require('fs');

/* Local function */
var get_package_data = require('../lib/get-package-data');

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
		console.log(x);
		res.send(x);
	}, function(err){
		next(createError(400, err));
	});
});

router.get('/:user/:package', function(req, res, next) {
	var user = req.params.user;
	var package = req.params.package
	packages.distinct('Version', {_user : user, Package : package}).then(function(x){
		console.log(x);
		res.send(x);
	}, function(err){
		next(createError(400, err));
	});
});

router.get('/:user/:package/:version', function(req, res, next) {
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

router.post('/:user/:package/:version', upload.fields([{ name: 'file', maxCount: 1 }]), function(req, res, next) {
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
		get_package_data(filepath, function(err, data) {
			if(err){
				next(createError(400, err));
			} else if(data.Package != package || data.Version != version){
				next(createError(400, 'Package name or version does not match upload'));
			} else {
				console.log(data);
				const hash = md5file.sync(filepath);
				bucket.delete(hash).then(function(){
					console.log("Replacing previous file " + hash);
				}, function(err){
					console.log("New file " + hash);
				}).finally(function(){
					fs.createReadStream(filepath).
					pipe(bucket.openUploadStreamWithId(hash, filename)).on('error', function(err) {
						next(createError(400, err));
					}).on('finish', function() {
						data['_user'] = user;
						data['_type'] = type;
						data['_hash'] = hash;
						data['_file'] = filename;
						data['_published'] = new Date();
						var filter = {_user : user, _type : type, Package : package, Version : version};
						packages.findOneAndReplace(filter, data, {upsert: true, returnOriginal: true}, function(err, result) {
							var original = result.value;
							if(err){
								next(createError(400, err));
							} else if(original){
								// delete the file if there are no other references to the hash
								var orighash = original['_hash'];
								packages.findOne({_hash : orighash}).then(function(doc){
									if(doc){
										console.log("Found other references, not deleting file: " + orighash);
									} else {
										bucket.delete(hash).then(function(){
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
		});
	}
});

module.exports = router;
