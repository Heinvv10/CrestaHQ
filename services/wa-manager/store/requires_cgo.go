//go:build !cgo

package store

// go-sqlite3 is a cgo package. Built with CGO_ENABLED=0 it compiles to a stub
// that fails only at RUNTIME, so the binary looks fine and cannot open its
// database. Referencing an undefined symbol turns that into a build error.
const _ = waManagerRequiresCGO_ENABLED_1_becauseGoSqlite3IsACgoPackage
