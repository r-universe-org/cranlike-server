const express = require('express');
const createError = require('http-errors');
const router = express.Router();
const { Octokit } = require("@octokit/rest");
const octokit = new Octokit({
	auth: process.env.WEBHOOK_PAT,
});

router.post('/', function(req, res, next) {
	console.log("Triggering webhook...")
	res.set('Cache-Control', 'no-cache');
	octokit.actions.createWorkflowDispatch({
	  owner: 'r-universe-org',
	  repo: 'setup-universes',
	  workflow_id : 'setup.yml',
	  ref: 'master',
	}).then(x => res.status(201).send(x))
	  .catch(x => next(createError(400, x)));
});

module.exports = router;
