; Tag queries for Rust, written for Butterfly Code.
;
; Capture contract (see scan.ts):
;   @name.definition.<kind> / @name.reference.<kind>  the identifier
;   @definition.<kind> / @reference.<kind>            the enclosing node (body range)

; ---------------------------------------------------------------- functions
; Free functions: crate root, inside `mod {}`, nested in a block, or
; declared in an `extern {}` block.

(source_file
  (function_item
    name: (identifier) @name.definition.function) @definition.function)

(mod_item
  body: (declaration_list
    (function_item
      name: (identifier) @name.definition.function) @definition.function))

(block
  (function_item
    name: (identifier) @name.definition.function) @definition.function)

(foreign_mod_item
  body: (declaration_list
    (function_signature_item
      name: (identifier) @name.definition.function) @definition.function))

; ------------------------------------------------------------------ methods
; Functions inside impl and trait bodies (trait methods may lack a body).

(impl_item
  body: (declaration_list
    (function_item
      name: (identifier) @name.definition.method) @definition.method))

(trait_item
  body: (declaration_list
    [
      (function_item name: (identifier) @name.definition.method)
      (function_signature_item name: (identifier) @name.definition.method)
    ] @definition.method))

; -------------------------------------------------------------------- types

(struct_item
  name: (type_identifier) @name.definition.struct) @definition.struct

(enum_item
  name: (type_identifier) @name.definition.enum) @definition.enum

(union_item
  name: (type_identifier) @name.definition.union) @definition.union

(trait_item
  name: (type_identifier) @name.definition.trait) @definition.trait

(type_item
  name: (type_identifier) @name.definition.type) @definition.type

; `type Key;` inside a trait
(associated_type
  name: (type_identifier) @name.definition.type) @definition.type

; ------------------------------------------------------- modules and macros

(mod_item
  name: (identifier) @name.definition.module) @definition.module

(macro_definition
  name: (identifier) @name.definition.macro) @definition.macro

; ----------------------------------------------------- constants and statics

(const_item
  name: (identifier) @name.definition.constant) @definition.constant

(static_item
  name: (identifier) @name.definition.variable) @definition.variable

; -------------------------------------------------------------------- calls

(call_expression
  function: (identifier) @name.reference.call) @reference.call

; value.method()
(call_expression
  function: (field_expression
    field: (field_identifier) @name.reference.call)) @reference.call

; path::to::function()
(call_expression
  function: (scoped_identifier
    name: (identifier) @name.reference.call)) @reference.call

; Type::new() also references the type (or module) it is called through.
((call_expression
  function: (scoped_identifier
    path: (identifier) @name.reference.type)) @reference.type
  (#not-eq? @name.reference.type "Self"))

; Turbofish forms: f::<T>(), v.collect::<T>(), Type::f::<T>()
(call_expression
  function: (generic_function
    function: (identifier) @name.reference.call)) @reference.call

(call_expression
  function: (generic_function
    function: (field_expression
      field: (field_identifier) @name.reference.call))) @reference.call

(call_expression
  function: (generic_function
    function: (scoped_identifier
      name: (identifier) @name.reference.call))) @reference.call

(macro_invocation
  macro: (identifier) @name.reference.macro) @reference.macro

(macro_invocation
  macro: (scoped_identifier
    name: (identifier) @name.reference.macro)) @reference.macro

; ------------------------------------------------------ struct construction
; Scoped literals (Enum::Variant { .. }) fall to the type-reference list.

(struct_expression
  name: (type_identifier) @name.reference.struct) @reference.struct

; --------------------------------------------------------- implementations
; Plain names only: generic (Foo<T>) and scoped (fmt::Display) impl headers
; are recorded once, by the type-reference list below.

(impl_item
  trait: (type_identifier) @name.reference.implementation) @reference.implementation

(impl_item
  type: (type_identifier) @name.reference.implementation) @reference.implementation

; ---------------------------------------------------------- type references
; Type identifiers in use positions. Declared names sit under `name:` and
; are never listed; plain impl headers and struct literals are handled
; above. `_` and `Self` name nothing worth linking.

([
  (parameter type: (type_identifier) @name.reference.type)
  (function_item return_type: (type_identifier) @name.reference.type)
  (function_signature_item return_type: (type_identifier) @name.reference.type)
  (closure_expression return_type: (type_identifier) @name.reference.type)
  (function_type return_type: (type_identifier) @name.reference.type)
  (field_declaration type: (type_identifier) @name.reference.type)
  (ordered_field_declaration_list type: (type_identifier) @name.reference.type)
  (let_declaration type: (type_identifier) @name.reference.type)
  (const_item type: (type_identifier) @name.reference.type)
  (static_item type: (type_identifier) @name.reference.type)
  (type_item type: (type_identifier) @name.reference.type)
  (reference_type type: (type_identifier) @name.reference.type)
  (pointer_type type: (type_identifier) @name.reference.type)
  (array_type element: (type_identifier) @name.reference.type)
  (tuple_type (type_identifier) @name.reference.type)
  (type_arguments (type_identifier) @name.reference.type)
  (type_binding type: (type_identifier) @name.reference.type)
  (trait_bounds (type_identifier) @name.reference.type)
  (where_predicate left: (type_identifier) @name.reference.type)
  (type_parameter default_type: (type_identifier) @name.reference.type)
  (dynamic_type trait: (type_identifier) @name.reference.type)
  (abstract_type trait: (type_identifier) @name.reference.type)
  (bounded_type (type_identifier) @name.reference.type)
  (removed_trait_bound (type_identifier) @name.reference.type)
  (qualified_type type: (type_identifier) @name.reference.type)
  (qualified_type alias: (type_identifier) @name.reference.type)
  (type_cast_expression type: (type_identifier) @name.reference.type)
  (struct_pattern type: (type_identifier) @name.reference.type)
  (generic_type type: (type_identifier) @name.reference.type)
  (scoped_type_identifier name: (type_identifier) @name.reference.type)
] @reference.type
  (#not-match? @name.reference.type "^(_|Self)$"))

; ------------------------------------------------------------------ imports
; use a::b::Name; use a::{B, c::D}; use a::Name as Alias;

(use_declaration
  argument: (scoped_identifier
    name: (identifier) @name.reference.import)) @reference.import

(use_declaration
  argument: (identifier) @name.reference.import) @reference.import

(use_as_clause
  path: (scoped_identifier
    name: (identifier) @name.reference.import)) @reference.import

(use_list
  (identifier) @name.reference.import) @reference.import

(use_list
  (scoped_identifier
    name: (identifier) @name.reference.import)) @reference.import
