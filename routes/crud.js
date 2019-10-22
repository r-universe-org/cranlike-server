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
router.get('/:user/archive', function(req, res, next) {
	res.send('List packages for:' + req.params.user);
});

router.get('/:user/archive/:package', function(req, res, next) {
	res.send('List versions for:' + req.params.user + "/" + req.params.package);
});

router.get('/:user/archive/:package/:version', function(req, res, next) {
	res.send('List binaries for:' + req.params.user + "/" + req.params.package + "/" + req.params.version);
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
		get_package_data(filepath, function(err, data) {
			if(err){
				next(createError(400, err));
			} else if(data.Package != package || data.Version != version){
				next(createError(400, 'Package name or version does not match upload'));
			} else {
				console.log(data);
				const hash = md5file.sync(filepath);
				fs.createReadStream(filepath).
				pipe(bucket.openUploadStreamWithId(hash, filename)).on('error', function(err) {
					next(createError(400, err));
				}).on('finish', function() {
					data['_id'] = hash
					packages.insertOne(data, function(err, r) {
						if(err){
							next(createError(400, err));
						} else if(r.insertedCount != 1){
							next(createError(400, "Inserted count not equal to 1: " + r.insertedCount));
						} else {
							res.send("Package upload successful: " + filename + '\n');
							console.log('done!');
						}
					});
				});
			}
		});
	}
});

module.exports = router;
