
# cranlike(7) &mdash; dynamic R package server

## SYNOPSIS

`GET /`&lt;date>/&lt;user>`/src/contrib`  
`GET /`&lt;date>/&lt;user>`/bin/windows/contrib`  
`GET /`&lt;date>/&lt;user>`/bin/macosx/el-capitan/contrib/`  

`POST /submit/`&lt;user>`/src`  
`POST /submit/`&lt;user>`/windows`  
`POST /submit/`&lt;user>`/macosx`  

## DESCRIPTION

**cranlike** is an R package server that provides a API for submitting
and downloading R packages. It automatically generates CRAN-like pages
from a database of packages.

This allows R users to install packages from a particular date or author
simply by setting the repo parameter in `install.packages()`.

## API

* `GET /` &lt;date>  
  Get repository state from date (in `yyyy-mm-dd`) or `latest` for current state.

* `GET /` &lt;date> `/` &lt;user>  
  Filter repository for packages published by a given author or 
  organization. Use `any` for all packages.

* `POST / submit /` &lt;user>  
  Publish a new release in the repository for a given author or organzation.
  Source and binary packages are published in separate submissions.

## EXAMPLES

install.packages('curl', repos = '[https://cran.dev/latest/jeroen](https://cran.dev/latest/jeroen)')  
install.packages('magick', repos = '[https://cran.dev/2019-01-01/any](https://cran.dev/2019-01-01/any)')