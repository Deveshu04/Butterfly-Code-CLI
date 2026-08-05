; Tag queries for TypeScript, written for Butterfly Code.
;
; Shared by the typescript and tsx grammars, so only node types present in
; both may appear here (no JSX patterns).
;
; Capture contract (see scan.ts):
;   @name.definition.<kind> / @name.reference.<kind>  the identifier
;   @definition.<kind> / @reference.<kind>            the enclosing node (body range)

; ---------------------------------------------------------------- functions

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(generator_function_declaration
  name: (identifier) @name.definition.function) @definition.function

; Overload and `declare function` signatures.
(function_signature
  name: (identifier) @name.definition.function) @definition.function

; Named function expressions: (function exec() {})(), return function iter() {}
(function_expression
  name: (identifier) @name.definition.function) @definition.function

(generator_function
  name: (identifier) @name.definition.function) @definition.function

; const f = () => {} / const f = function () {}
(variable_declarator
  name: (identifier) @name.definition.function
  value: [(arrow_function) (function_expression) (generator_function)]) @definition.function

; exports.f = function () {} / Foo.f = () => {}
(assignment_expression
  left: (member_expression
    object: (identifier)
    property: (property_identifier) @name.definition.function)
  right: [(arrow_function) (function_expression) (generator_function)]) @definition.function

; module.exports.f = function () {}
(assignment_expression
  left: (member_expression
    object: (member_expression
      property: (property_identifier) @_holder)
    property: (property_identifier) @name.definition.function)
  right: [(arrow_function) (function_expression) (generator_function)]
  (#eq? @_holder "exports")) @definition.function

; ------------------------------------------------------------------ classes

(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

(abstract_class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

; const K = class Named {}
(class
  name: (type_identifier) @name.definition.class) @definition.class

; ------------------------------------------------------------------ methods

((method_definition
  name: [(property_identifier) (private_property_identifier)] @name.definition.method) @definition.method
  (#not-eq? @name.definition.method "constructor"))

(abstract_method_signature
  name: [(property_identifier) (private_property_identifier)] @name.definition.method) @definition.method

(method_signature
  name: (property_identifier) @name.definition.method) @definition.method

; class fields holding functions: handle = () => {}
(public_field_definition
  name: [(property_identifier) (private_property_identifier)] @name.definition.method
  value: [(arrow_function) (function_expression) (generator_function)]) @definition.method

; { run: () => {} } in object literals
(pair
  key: (property_identifier) @name.definition.method
  value: [(arrow_function) (function_expression) (generator_function)]) @definition.method

; Foo.prototype.bar = function () {}
(assignment_expression
  left: (member_expression
    object: (member_expression
      property: (property_identifier) @_prototype)
    property: (property_identifier) @name.definition.method)
  right: [(arrow_function) (function_expression) (generator_function)]
  (#eq? @_prototype "prototype")) @definition.method

; obj.inner.handler = () => {} / this.handler = function () {}
(assignment_expression
  left: (member_expression
    object: (member_expression
      property: (property_identifier) @_holder)
    property: (property_identifier) @name.definition.method)
  right: [(arrow_function) (function_expression) (generator_function)]
  (#not-any-of? @_holder "prototype" "exports")) @definition.method

(assignment_expression
  left: (member_expression
    object: (this)
    property: (property_identifier) @name.definition.method)
  right: [(arrow_function) (function_expression) (generator_function)]) @definition.method

; ------------------------------------------------------------- type shapes

(interface_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

(type_alias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; namespace Foo {} / module Foo.Bar {}
(internal_module
  name: [(identifier) (nested_identifier)] @name.definition.module) @definition.module

(module
  name: [(identifier) (nested_identifier)] @name.definition.module) @definition.module

; declare module "pkg" {}
(module
  name: (string (string_fragment) @name.definition.module)) @definition.module

; ---------------------------------------------------------------- constants
; Module-level SCREAMING_CASE consts only; ordinary locals are noise.
; Function values are excluded (they are tagged as functions above).

(program
  (lexical_declaration
    kind: "const"
    (variable_declarator
      name: (identifier) @name.definition.constant
      value: [
        (string) (template_string) (number) (regex) (true) (false) (null)
        (undefined) (identifier) (member_expression) (subscript_expression)
        (array) (object) (call_expression) (new_expression) (binary_expression)
        (unary_expression) (ternary_expression) (parenthesized_expression)
        (await_expression) (as_expression) (satisfies_expression)
        (non_null_expression)
      ])) @definition.constant
  (#match? @name.definition.constant "^[A-Z][A-Z0-9_]*$"))

(program
  (export_statement
    declaration: (lexical_declaration
      kind: "const"
      (variable_declarator
        name: (identifier) @name.definition.constant
        value: [
          (string) (template_string) (number) (regex) (true) (false) (null)
          (undefined) (identifier) (member_expression) (subscript_expression)
          (array) (object) (call_expression) (new_expression) (binary_expression)
          (unary_expression) (ternary_expression) (parenthesized_expression)
          (await_expression) (as_expression) (satisfies_expression)
          (non_null_expression)
        ])) @definition.constant)
  (#match? @name.definition.constant "^[A-Z][A-Z0-9_]*$"))

; -------------------------------------------------------------------- calls

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: [(property_identifier) (private_property_identifier)] @name.reference.call)) @reference.call

; ---------------------------------------------------- class instantiation

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

(new_expression
  constructor: (member_expression
    property: (property_identifier) @name.reference.class)) @reference.class

; class A extends B
(extends_clause
  value: (identifier) @name.reference.class) @reference.class

(extends_clause
  value: (member_expression
    property: (property_identifier) @name.reference.class)) @reference.class

; ---------------------------------------------------------- type references
; Type identifiers in use positions. Declared names (class, interface, type
; alias, type parameter) sit under a `name:` field and are never listed here.

[
  (type_annotation (type_identifier) @name.reference.type)
  (opting_type_annotation (type_identifier) @name.reference.type)
  (omitting_type_annotation (type_identifier) @name.reference.type)
  (adding_type_annotation (type_identifier) @name.reference.type)
  (union_type (type_identifier) @name.reference.type)
  (intersection_type (type_identifier) @name.reference.type)
  (array_type (type_identifier) @name.reference.type)
  (tuple_type (type_identifier) @name.reference.type)
  (optional_type (type_identifier) @name.reference.type)
  (rest_type (type_identifier) @name.reference.type)
  (readonly_type (type_identifier) @name.reference.type)
  (parenthesized_type (type_identifier) @name.reference.type)
  (lookup_type (type_identifier) @name.reference.type)
  (index_type_query (type_identifier) @name.reference.type)
  (template_type (type_identifier) @name.reference.type)
  (conditional_type (type_identifier) @name.reference.type)
  (type_arguments (type_identifier) @name.reference.type)
  (constraint (type_identifier) @name.reference.type)
  (default_type (type_identifier) @name.reference.type)
  (function_type return_type: (type_identifier) @name.reference.type)
  (constructor_type type: (type_identifier) @name.reference.type)
  (type_predicate type: (type_identifier) @name.reference.type)
  (mapped_type_clause type: (type_identifier) @name.reference.type)
  (as_expression (type_identifier) @name.reference.type)
  (satisfies_expression (type_identifier) @name.reference.type)
  (extends_type_clause type: (type_identifier) @name.reference.type)
  (implements_clause (type_identifier) @name.reference.type)
  (type_alias_declaration value: (type_identifier) @name.reference.type)
  (generic_type name: (type_identifier) @name.reference.type)
  (nested_type_identifier name: (type_identifier) @name.reference.type)
] @reference.type

; ------------------------------------------------------------------ imports
; import { a, b as c } from "./x" references the exported names a and b.

(import_specifier
  name: (identifier) @name.reference.import) @reference.import

(export_specifier
  name: (identifier) @name.reference.export) @reference.export
