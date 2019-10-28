
# cranlike(7) &mdash; dynamic R package server

## SYNOPSIS

`GET,POST,DELETE`  
&nbsp; `/api/`&lt;*user*>`/`&lt;*package*>`/`&lt;*version*>`/`&lt;*type*>  

`GET`  
&nbsp; `/repos/`&lt;*user*>`/src/contrib`  
&nbsp; `/repos/`&lt;*user*>`/bin/windows/contrib`  
&nbsp; `/repos/`&lt;*user*>`/bin/macosx/el-capitan/contrib/`  


## DESCRIPTION

**cranlike** is a package server providing a simple API for storing
R packages and hosting cran-like repositories. 

Packages are published in the repository of a particular user or 
organization, and the server automatically generates the required 
repository index files from the database. 
This allows R users to install packages from a particular author or 
organization using only the repo parameter in `install.packages()`.

The implementation is designed to be fast and extensible, with the
potential expose additional filters or services, and scale up to
large repositories.

## API

* `GET /`  
  List available users / organizations.

* `GET /` &lt;*user*> `/ {src,bin} /`  
  CRAN-like repository for packages published by a given author
  or organization. Use `any` for packages from all users.

* `GET /` &lt;*user*>  `/ old /` &lt;*date*> `/ {src,bin} /`  
  CRAN-like repository for user as it was on date (in `yyyy-mm-dd`).

* `GET,PUT,DELETE / archive /` &lt;*user*> `/` &lt;*package*> `/` &lt;*version*> `/`  
  CRUD API to upload and download package files to the server.

## EXAMPLES

install.packages('curl', repos = "https://mycorp.org/repos/jeroen")  
