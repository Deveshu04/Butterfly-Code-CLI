; Tag queries for Python, written for Butterfly Code.
;
; Capture contract (see scan.ts):
;   @name.definition.<kind> / @name.reference.<kind>  the identifier
;   @definition.<kind> / @reference.<kind>            the enclosing node (body range)

; ------------------------------------------------------------------ classes

(class_definition
  name: (identifier) @name.definition.class) @definition.class

; ------------------------------------------------------------------ methods
; A def directly inside a class body (decorated or not).

(class_definition
  body: (block
    (function_definition
      name: (identifier) @name.definition.method) @definition.method))

(class_definition
  body: (block
    (decorated_definition
      definition: (function_definition
        name: (identifier) @name.definition.method) @definition.method)))

; ---------------------------------------------------------------- functions
; Every other def: module level, nested in a function, or under a compound
; statement (if/try/with/for/while/match). Class bodies are deliberately
; absent so a def is never reported as both function and method.

[
  (module
    (function_definition name: (identifier) @name.definition.function) @definition.function)
  (module
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function))

  (function_definition body: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (function_definition body: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))

  (if_statement consequence: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (if_statement consequence: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))
  (elif_clause consequence: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (elif_clause consequence: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))
  (else_clause body: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (else_clause body: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))

  (try_statement body: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (try_statement body: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))
  (except_clause (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (except_clause (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))
  (finally_clause (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (finally_clause (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))

  (with_statement body: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (with_statement body: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))
  (for_statement body: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (for_statement body: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))
  (while_statement body: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (while_statement body: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))
  (case_clause consequence: (block
    (function_definition name: (identifier) @name.definition.function) @definition.function))
  (case_clause consequence: (block
    (decorated_definition
      definition: (function_definition name: (identifier) @name.definition.function) @definition.function)))
]

; square = lambda v: v * v (module level)
(module
  (expression_statement
    (assignment
      left: (identifier) @name.definition.function
      right: (lambda)) @definition.function))

; ------------------------------------------------------------- type aliases

; type Vec = list[float]
(type_alias_statement
  left: (type (identifier) @name.definition.type)) @definition.type

; --------------------------------------------------- module-level variables
; SCREAMING_CASE names are constants; other module-level assignments
; (excluding lambdas, reported as functions above) are variables.

((module
  (expression_statement
    (assignment
      left: (identifier) @name.definition.constant) @definition.constant))
  (#match? @name.definition.constant "^_?[A-Z][A-Z0-9_]*$"))

((module
  (expression_statement
    (assignment
      left: (pattern_list (identifier) @name.definition.constant)) @definition.constant))
  (#match? @name.definition.constant "^_?[A-Z][A-Z0-9_]*$"))

((module
  (expression_statement
    (assignment
      left: (identifier) @name.definition.variable
      right: (_) @_value) @definition.variable))
  (#not-match? @name.definition.variable "^_?[A-Z][A-Z0-9_]*$")
  (#not-match? @_value "^lambda"))

; -------------------------------------------------------------------- calls

(call
  function: (identifier) @name.reference.call) @reference.call

(call
  function: (attribute
    attribute: (identifier) @name.reference.call)) @reference.call

; Bare decorators (@property, @app.route without a call) invoke a callable.
(decorator
  (identifier) @name.reference.call) @reference.call

(decorator
  (attribute
    attribute: (identifier) @name.reference.call)) @reference.call

; ------------------------------------------------------------- inheritance

(class_definition
  superclasses: (argument_list
    (identifier) @name.reference.class)) @reference.class

(class_definition
  superclasses: (argument_list
    (attribute
      attribute: (identifier) @name.reference.class))) @reference.class

; ---------------------------------------------------------- type references

(type
  (identifier) @name.reference.type) @reference.type

(type
  (attribute
    attribute: (identifier) @name.reference.type)) @reference.type

(generic_type
  (identifier) @name.reference.type) @reference.type

; ------------------------------------------------------------------ imports
; from pkg import name / from pkg import name as alias references `name`.

(import_from_statement
  name: (dotted_name
    (identifier) @name.reference.import .)) @reference.import

(import_from_statement
  name: (aliased_import
    name: (dotted_name
      (identifier) @name.reference.import .))) @reference.import
