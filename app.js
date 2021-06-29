/* Express template stuff */
var createError = require('http-errors');
var express = require('express');
var cors = require('cors')
var path = require('path');
var logger = require('morgan');

/* Database */
const assert = require('assert');
const mongodb = require('mongodb');

/* Routers */
var manRouter = require('./routes/man');
var apiRouter = require('./routes/api');
var reposRouter = require('./routes/repos');
var badgesRouter = require('./routes/badges');

/* Connect to DB */
const HOST = process.env.CRANLIKE_MONGODB_SERVER || 'localhost';
const PORT = process.env.CRANLIKE_MONGODB_PORT || 27017;
const USER = process.env.CRANLIKE_MONGODB_USERNAME || 'root';
const PASS = process.env.CRANLIKE_MONGODB_PASSWORD;
const AUTH = PASS ? (USER + ':' + PASS + "@") : "";
const URL = 'mongodb://' + AUTH + HOST + ':' + PORT;
mongodb.MongoClient.connect(URL, {useUnifiedTopology: true}, function(error, client) {
	assert.ifError(error);
	const db = client.db('cranlike');
	global.bucket = new mongodb.GridFSBucket(db, {bucketName: 'files'});
	global.packages = db.collection('packages');
});

/* Start App */
var app = express();

/* Prettify all JSON responses */
app.set('json spaces', 2)

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(cors())
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use('/', manRouter);
app.use('/', apiRouter);
app.use('/', reposRouter);
app.use('/', badgesRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
