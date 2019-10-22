# CRANLIKE

Package server to generate CRAN-like repositories. 

## REST API

See [docs/api.md](docs/api.md).

## Read data in R

When running locally you can inspect the packages data directly in R:

```r
library(mongolite)
packages <- mongo(db = 'cranlike', collection = 'packages')
packages$find()
```

To inspect the table with the files:

```r
bucket <- gridfs(db = 'cranlike', prefix = 'files')
bucket$find()
```

