/* Express template stuff */
var createError = require('http-errors');
var express = require('express');
var cors = require('cors')
var path = require('path');
var logger = require('morgan');

/* Routers */
var manRouter = require('./routes/man');
var cdnRouter = require('./routes/cdn');
var packagesRouter = require('./routes/packages');
var reposRouter = require('./routes/repos');
var searchRouter = require('./routes/search');
var badgesRouter = require('./routes/badges');
var feedsRouter = require('./routes/feeds');
var sharedRouter = require('./routes/shared');
var scienceMinerRouter = require('./routes/scienceminer');
var snapshotRouter = require('./routes/snapshot');
var v2Router = require('./routes/v2');
var webrRouter = require('./routes/webr');

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
app.use('/', cdnRouter);
app.use('/', packagesRouter);
app.use('/', reposRouter);
app.use('/', searchRouter);
app.use('/', badgesRouter);
app.use('/', feedsRouter);
app.use('/', sharedRouter);
app.use('/', scienceMinerRouter);
app.use('/', snapshotRouter);
app.use('/', v2Router);
app.use('/', webrRouter);

// catch 404 and forward to error handler
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  res.locals.message = err.message;
  res.locals.error = err;

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
