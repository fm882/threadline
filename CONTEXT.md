# Time-Aware Research Agent

A conversational research assistant that recalls prior discussions and compares historical assertions with current source evidence.

## Language

**Conversation**:
A sequence of exchanges belonging to one user, with its own immediate conversational context.
_Avoid_: Session when referring to a discussion rather than a login.

**Retained history**:
The user's past discussions that remain stored, including discussions in other conversations. Retention does not mean every discussion is eligible for automatic recall.
_Avoid_: Memory when the intended meaning is the original discussion record.

**Historical reference**:
A reference in the current question to an earlier discussion, question, answer, or discussed subject, whether in the current conversation or another conversation.
_Avoid_: Date reference, since a historical reference need not contain a date.

**Source conversation**:
The conversation containing the original discussion used to resolve a historical reference.
_Avoid_: Source alone when it could mean an external web source.

**Ambiguous historical reference**:
A historical reference with multiple plausible earlier discussions that would materially change the answer.
_Avoid_: Low confidence as a substitute for identifying the competing interpretations.

**Historical baseline**:
The earlier state of a subject used for comparison, with the relevant time period and the evidence supporting that state identified.
_Avoid_: Previous answer when referring to an evidenced earlier state rather than what the assistant said.

**Reconstructed baseline**:
A historical baseline established using evidence discovered after the original discussion that explicitly supports the relevant earlier period.
_Avoid_: Verified then, since discovering historical evidence later does not establish that the original answer was verified at the time.

**User-reported baseline**:
An earlier state or quote supplied by the user and used for an explicitly attributed comparison, without implying independent external verification.
_Avoid_: Verified baseline when no supporting external evidence exists.

**Correction**:
A later statement that replaces an earlier interpretation or discussed subject for subsequent references while preserving what was originally said.
_Avoid_: Edit when the original record is retained.

**Recall exclusion**:
A user's choice that a conversation must not supply automatic historical context to other conversations; it is distinct from deleting that conversation.
_Avoid_: Deletion, forgetting, or private mode when those imply removal or different access guarantees.

**Significant update**:
A change materially relevant to the user's stated needs, such as relevant capabilities, pricing, breaking changes, deprecations or availability.
_Avoid_: Big launch when significance rests only on vendor marketing.

**Research continuation**:
An explicit follow-up that resumes an incomplete research question using the previous findings and clearly identified remaining gaps.
_Avoid_: Retry when the user is asking for additional research rather than recovery of failed execution.
