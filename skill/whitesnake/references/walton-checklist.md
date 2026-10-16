# Critical questions (after Walton's argumentation schemes)

Run these when there is **no precedent**, when **confidence is low**, or when **a procedure and your own reading disagree**. Answer them in the decision body or in `rebuttal.text`; raise a `question` node when you cannot.

**Argument from sign** (the text shows X, therefore Y)
- Could the sign be produced by something other than Y (a different population, a different time point, a typo)?
- Is the sign reported for the whole unit or for a subgroup?

**Argument from precedent** (unit A was treated this way, so unit B is too)
- Is B relevantly similar to A on the features the criterion depends on?
- Did the researcher accept A's decision, or is A itself only proposed?

**Argument from the author's position to know** (the paper states it)
- Does the paper state it, or do you infer it from a table caption or a figure?
- Do two places in the paper disagree? Cite both as evidence and choose with a criterion.

**Argument from absence** (not reported, therefore not done)
- Would this paper have reported it if it were true (journal requirements, reporting guideline)?
- Is there a supplement or protocol that might report it?

**Procedure versus reading disagreement**
- Which input did the procedure actually consume? Record its output as `execution` evidence.
- Is the case inside the procedure's `applicability`, or one of its `abstain_when` conditions? If the latter, record the episode with the procedure in `uses` and your own reading in a separate evidence node, and lower confidence.
