{{- define "atlas-web.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "atlas-web.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "atlas-web.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "atlas-web.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "atlas-web.selectorLabels" -}}
app.kubernetes.io/name: {{ include "atlas-web.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "atlas-web.image" -}}
{{- $repository := required "image.repository is required: set it to the atlas-web image you built or pulled" .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{ $repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ $repository }}:{{ default .Chart.AppVersion .Values.image.tag }}
{{- end -}}
{{- end }}
