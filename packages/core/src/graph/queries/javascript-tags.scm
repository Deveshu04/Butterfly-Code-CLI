; Tag queries for JavaScript, written for Butterfly Code.
;
; Capture contract (see scan.ts):
;   @name.definition.<kind> / @name.reference.<kind>  the identifier
;   @definition.<kind> / @reference.<kind>            the enclosing node (body range)

; ---------------------------------------------------------------- functions

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

(generator_function_declaration
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
  name: (identifier) @name.definition.class) @definition.class

; const K = class Named {}
(class
  name: (identifier) @name.definition.class) @definition.class

; ------------------------------------------------------------------ methods

((method_definition
  name: [(property_identifier) (private_property_identifier)] @name.definition.method) @definition.method
  (#not-eq? @name.definition.method "constructor"))

; class fields holding functions: handle = () => {}
(field_definition
  property: [(property_identifier) (private_property_identifier)] @name.definition.method
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
        (await_expression)
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
          (await_expression)
        ])) @definition.constant)
  (#match? @name.definition.constant "^[A-Z][A-Z0-9_]*$"))

; -------------------------------------------------------------------- calls

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (member_expression
    property: [(property_identifier) (private_property_identifier)] @name.reference.call)) @reference.call

; JSX components (capitalised tags) are calls in all but syntax.
((jsx_opening_element
  name: (identifier) @name.reference.call) @reference.call
  (#match? @name.reference.call "^[A-Z]"))

((jsx_self_closing_element
  name: (identifier) @name.reference.call) @reference.call
  (#match? @name.reference.call "^[A-Z]"))

(jsx_opening_element
  name: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call

(jsx_self_closing_element
  name: (member_expression
    property: (property_identifier) @name.reference.call)) @reference.call

; ---------------------------------------------------- class instantiation

(new_expression
  constructor: (identifier) @name.reference.class) @reference.class

(new_expression
  constructor: (member_expression
    property: (property_identifier) @name.reference.class)) @reference.class

; class A extends B
(class_heritage
  (identifier) @name.reference.class) @reference.class

(class_heritage
  (member_expression
    property: (property_identifier) @name.reference.class)) @reference.class

; ------------------------------------------------------------------ imports
; import { a, b as c } from "./x" references the exported names a and b.

(import_specifier
  name: (identifier) @name.reference.import) @reference.import

(export_specifier
  name: (identifier) @name.reference.export) @reference.export

; const { a, b: c } = require("./x")
(variable_declarator
  name: (object_pattern
    (shorthand_property_identifier_pattern) @name.reference.import)
  value: (call_expression
    function: (identifier) @_require)
  (#eq? @_require "require")) @reference.import

(variable_declarator
  name: (object_pattern
    (pair_pattern
      key: (property_identifier) @name.reference.import))
  value: (call_expression
    function: (identifier) @_require)
  (#eq? @_require "require")) @reference.import
