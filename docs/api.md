
# cranlike(7) &mdash; dynamic R package server

## SYNOPSIS

`GET /`&lt;user>`/src/contrib`  
`GET /`&lt;user>`/bin/windows/contrib`  
`GET /`&lt;user>`/bin/macosx/el-capitan/contrib/`  

`GET /`&lt;user>`/old/`&lt;date>`/src/contrib`  
`GET /`&lt;user>`/old/`&lt;date>`/bin/windows/contrib`  
`GET /`&lt;user>`/old/`&lt;date>`/bin/macosx/el-capitan/contrib/`  

`POST /submit/`&lt;user>`/src`  
`POST /submit/`&lt;user>`/windows`  
`POST /submit/`&lt;user>`/macosx`  

## DESCRIPTION

**cranlike** is a package server that provides a API for submitting
and downloading R packages. It automatically generates the required
pages and `PACKAGES.gz` index files from the package database.

This allows R users to install packages from a particular author or
organization or date using the repo parameter in `install.packages()`.

## API

* `GET /`  
  List all available users / organizations.

* `GET /` &lt;user> `/ {src, windows, macosx} /`  
  Get CRAN-like repository for packages published by a given author
  or organization. Use `any` for packages from all users.

* `GET /` &lt;user>  `/ old /` &lt;date> `/ {src, windows, macosx} /`  
  Get CRAN-like repository as it was on date (in `yyyy-mm-dd`).

* `POST / submit /` &lt;user>  `/ {src, windows, macosx}`  
  Publish a new release in the repository for a given author or organzation.
  Source and binary packages are published in separate submissions.

## EXAMPLES

install.packages('curl', repos = '[https://cran.dev/latest/jeroen](https://cran.dev/latest/jeroen)')  
install.packages('magick', repos = '[https://cran.dev/2019-01-01/any](https://cran.dev/2019-01-01/any)')