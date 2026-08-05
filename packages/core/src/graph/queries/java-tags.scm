; Tag queries for Java, written for Butterfly Code.
;
; Capture contract (see scan.ts):
;   @name.definition.<kind> / @name.reference.<kind>  the identifier
;   @definition.<kind> / @reference.<kind>            the enclosing node (body range)

; ------------------------------------------------------------------ package

(package_declaration
  [(identifier) (scoped_identifier)] @name.definition.module) @definition.module

; -------------------------------------------------------------------- types

(class_declaration
  name: (identifier) @name.definition.class) @definition.class

(record_declaration
  name: (identifier) @name.definition.record) @definition.record

(interface_declaration
  name: (identifier) @name.definition.interface) @definition.interface

; @interface Marker {}
(annotation_type_declaration
  name: (identifier) @name.definition.interface) @definition.interface

(enum_declaration
  name: (identifier) @name.definition.enum) @definition.enum

; ------------------------------------------------------------------ methods
; Constructors are left out: they share the class name, which is already tagged.

(method_declaration
  name: (identifier) @name.definition.method) @definition.method

(annotation_type_element_declaration
  name: (identifier) @name.definition.method) @definition.method

; ---------------------------------------------------------------- constants

; static final fields
((field_declaration
  (modifiers) @_modifiers
  declarator: (variable_declarator
    name: (identifier) @name.definition.constant)) @definition.constant
  (#match? @_modifiers "static")
  (#match? @_modifiers "final"))

; Interface fields are implicitly static final.
(constant_declaration
  declarator: (variable_declarator
    name: (identifier) @name.definition.constant)) @definition.constant

; -------------------------------------------------------------------- calls

(method_invocation
  name: (identifier) @name.reference.call) @reference.call

; Foo::bar method references
(method_reference
  (identifier) @name.reference.call .) @reference.call

; ---------------------------------------------------- class instantiation

(object_creation_expression
  type: (type_identifier) @name.reference.class) @reference.class

(object_creation_expression
  type: (generic_type
    (type_identifier) @name.reference.class)) @reference.class

(object_creation_expression
  type: (scoped_type_identifier
    (type_identifier) @name.reference.class .)) @reference.class

; ------------------------------------------------------------- inheritance

(superclass
  (type_identifier) @name.reference.class) @reference.class

(superclass
  (generic_type
    (type_identifier) @name.reference.class)) @reference.class

; implements A, B<C> / interface X extends Y
[
  (super_interfaces (type_list (type_identifier) @name.reference.implementation))
  (super_interfaces (type_list (generic_type (type_identifier) @name.reference.implementation)))
  (extends_interfaces (type_list (type_identifier) @name.reference.implementation))
  (extends_interfaces (type_list (generic_type (type_identifier) @name.reference.implementation)))
] @reference.implementation

; ---------------------------------------------------------- type references
; Type identifiers in use positions. Heritage clauses and `new` are handled
; above; generic types in those positions are excluded here by listing
; generic_type only under its use-site parents.

[
  (formal_parameter type: (type_identifier) @name.reference.type)
  (spread_parameter (type_identifier) @name.reference.type)
  (method_declaration type: (type_identifier) @name.reference.type)
  (annotation_type_element_declaration type: (type_identifier) @name.reference.type)
  (local_variable_declaration type: (type_identifier) @name.reference.type)
  (field_declaration type: (type_identifier) @name.reference.type)
  (constant_declaration type: (type_identifier) @name.reference.type)
  (resource type: (type_identifier) @name.reference.type)
  (catch_type (type_identifier) @name.reference.type)
  (throws (type_identifier) @name.reference.type)
  (cast_expression type: (type_identifier) @name.reference.type)
  (instanceof_expression right: (type_identifier) @name.reference.type)
  (array_type element: (type_identifier) @name.reference.type)
  (type_arguments (type_identifier) @name.reference.type)
  (type_bound (type_identifier) @name.reference.type)
  (wildcard (type_identifier) @name.reference.type)
  (class_literal (type_identifier) @name.reference.type)
  (scoped_type_identifier (type_identifier) @name.reference.type .)

  (formal_parameter type: (generic_type (type_identifier) @name.reference.type))
  (method_declaration type: (generic_type (type_identifier) @name.reference.type))
  (local_variable_declaration type: (generic_type (type_identifier) @name.reference.type))
  (field_declaration type: (generic_type (type_identifier) @name.reference.type))
  (type_arguments (generic_type (type_identifier) @name.reference.type))
  (type_bound (generic_type (type_identifier) @name.reference.type))
  (wildcard (generic_type (type_identifier) @name.reference.type))
  (array_type element: (generic_type (type_identifier) @name.reference.type))
  (cast_expression type: (generic_type (type_identifier) @name.reference.type))
] @reference.type

; Annotations name their annotation type.
(marker_annotation
  name: (identifier) @name.reference.type) @reference.type

(annotation
  name: (identifier) @name.reference.type) @reference.type

; ------------------------------------------------------------------ imports
; import a.b.Name; import static a.b.C.member; (wildcard imports skipped)

(import_declaration
  (scoped_identifier
    name: (identifier) @name.reference.import) .) @reference.import
