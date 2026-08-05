; Tag queries for Go, written for Butterfly Code.
;
; Capture contract (see scan.ts):
;   @name.definition.<kind> / @name.reference.<kind>  the identifier
;   @definition.<kind> / @reference.<kind>            the enclosing node (body range)

; ------------------------------------------------------------------ package

(package_clause
  (package_identifier) @name.definition.module) @definition.module

; ---------------------------------------------------- functions and methods

(function_declaration
  name: (identifier) @name.definition.function) @definition.function

; func (r *Recv) Name() — the receiver is not part of the tag.
(method_declaration
  name: (field_identifier) @name.definition.method) @definition.method

; Methods declared by an interface.
(method_elem
  name: (field_identifier) @name.definition.method) @definition.method

; -------------------------------------------------------------------- types

(type_spec
  name: (type_identifier) @name.definition.struct
  type: (struct_type)) @definition.struct

(type_spec
  name: (type_identifier) @name.definition.interface
  type: (interface_type)) @definition.interface

; Named types over anything else: type Celsius float64, type Handler func().
(type_spec
  name: (type_identifier) @name.definition.type
  type: [
    (type_identifier) (qualified_type) (generic_type) (pointer_type)
    (slice_type) (array_type) (map_type) (channel_type) (function_type)
    (parenthesized_type) (negated_type)
  ]) @definition.type

; type ID = string
(type_alias
  name: (type_identifier) @name.definition.type) @definition.type

; ----------------------------------------------------- constants, variables

(const_spec
  name: (identifier) @name.definition.constant) @definition.constant

; Package-level vars only; function locals are noise for a code map.
(source_file
  (var_declaration
    (var_spec
      name: (identifier) @name.definition.variable) @definition.variable))

(source_file
  (var_declaration
    (var_spec_list
      (var_spec
        name: (identifier) @name.definition.variable) @definition.variable)))

; -------------------------------------------------------------------- calls

(call_expression
  function: (identifier) @name.reference.call) @reference.call

(call_expression
  function: (selector_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; Explicit instantiation: Map[int](xs) / pkg.Map[int](xs). When the parser
; reads it as a conversion to a generic type instead, the type list below
; still records the reference.
(call_expression
  function: (index_expression
    operand: (identifier) @name.reference.call)) @reference.call

(call_expression
  function: (index_expression
    operand: (selector_expression
      field: (field_identifier) @name.reference.call))) @reference.call

; ---------------------------------------------------------- type references
; Type identifiers in use positions. Declared names (type_spec / type_alias
; `name:`) are never listed here.

[
  (parameter_declaration type: (type_identifier) @name.reference.type)
  (variadic_parameter_declaration type: (type_identifier) @name.reference.type)
  (function_declaration result: (type_identifier) @name.reference.type)
  (method_declaration result: (type_identifier) @name.reference.type)
  (method_elem result: (type_identifier) @name.reference.type)
  (func_literal result: (type_identifier) @name.reference.type)
  (function_type result: (type_identifier) @name.reference.type)
  (field_declaration type: (type_identifier) @name.reference.type)
  (var_spec type: (type_identifier) @name.reference.type)
  (const_spec type: (type_identifier) @name.reference.type)
  (type_spec type: (type_identifier) @name.reference.type)
  (type_alias type: (type_identifier) @name.reference.type)
  (pointer_type (type_identifier) @name.reference.type)
  (slice_type element: (type_identifier) @name.reference.type)
  (array_type element: (type_identifier) @name.reference.type)
  (implicit_length_array_type element: (type_identifier) @name.reference.type)
  (map_type key: (type_identifier) @name.reference.type)
  (map_type value: (type_identifier) @name.reference.type)
  (channel_type value: (type_identifier) @name.reference.type)
  (composite_literal type: (type_identifier) @name.reference.type)
  (type_assertion_expression type: (type_identifier) @name.reference.type)
  (type_case (type_identifier) @name.reference.type)
  (parenthesized_type (type_identifier) @name.reference.type)
  (type_elem (type_identifier) @name.reference.type)
  (type_constraint (type_identifier) @name.reference.type)
  (negated_type (type_identifier) @name.reference.type)
  (generic_type type: (type_identifier) @name.reference.type)
  (qualified_type name: (type_identifier) @name.reference.type)
  ; new(T), make([]T, n) and similar builtins take a type as an argument.
  (argument_list (type_identifier) @name.reference.type)
] @reference.type

; The package half of pkg.Type.
(qualified_type
  package: (package_identifier) @name.reference.module) @reference.module
