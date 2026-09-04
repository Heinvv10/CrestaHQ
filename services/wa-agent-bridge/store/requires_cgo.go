//go:build !cgo

package store

// This file turns a silent runtime failure into a loud build failure.
//
// go-sqlite3 is a cgo package. With CGO_ENABLED=0 it still COMPILES — it
// swaps in a stub — so `CGO_ENABLED=0 go build ./...` exits 0 and hands you a
// binary that dies only when it first tries to open its store, in production,
// with the message "This is a stub". CGO_ENABLED=0 is the default for
// cross-compiles and for scratch/distroless images, and CI never noticed
// because `-race` forces cgo back on.
//
// The undefined identifier below is deliberate: it fails the build with the
// reason in the error text. Do not "fix" it by declaring it.
const _ = waAgentBridgeRequiresCGO_ENABLED_1_becauseGoSqlite3IsACgoPackage
